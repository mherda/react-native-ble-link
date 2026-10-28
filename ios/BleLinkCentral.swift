import CoreBluetooth
import Foundation

/// Phone role: scans for the link service and talks to hubs over GATT.
/// All methods must be called on `queue` (the manager's delegate queue).
final class BleLinkCentral: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private enum Operation {
    case read(CBUUID)
    case write(CBUUID, Data)
  }

  private struct PendingOperation {
    let operation: Operation
    let resolve: Resolve
    let reject: Reject
  }

  /// One GATT connection and its serial operation queue.
  private final class Link {
    let peripheral: CBPeripheral
    let uuids: GattUuids
    var connect: (resolve: Resolve, reject: Reject)?
    var connectTimeout: DispatchWorkItem?
    var characteristics: [CBUUID: CBCharacteristic] = [:]
    var ready = false
    var queue: [PendingOperation] = []
    var current: PendingOperation?
    var currentTimeout: DispatchWorkItem?
    var disconnectWaiters: [Resolve] = []

    init(peripheral: CBPeripheral, uuids: GattUuids) {
      self.peripheral = peripheral
      self.uuids = uuids
    }
  }

  private static let operationTimeout: TimeInterval = 10

  private let queue: DispatchQueue
  private let emit: Emit
  private var manager: CBCentralManager!
  private let stateWaiters = ManagerStateWaiters()

  private var scanService: CBUUID?
  private var discovered: [String: CBPeripheral] = [:]
  private var links: [String: Link] = [:]

  init(queue: DispatchQueue, emit: @escaping Emit) {
    self.queue = queue
    self.emit = emit
    super.init()
    manager = CBCentralManager(
      delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
  }

  func currentState(_ resolve: @escaping Resolve) {
    let state = manager.state
    guard state == .unknown || state == .resetting else {
      return resolve(bluetoothStateString(state))
    }
    stateWaiters.add(
      on: queue, timeout: 2,
      onState: { resolve(bluetoothStateString($0)) },
      onTimeout: { [weak self] in resolve(bluetoothStateString(self?.manager.state ?? .unknown)) })
  }

  func shutdown() {
    stopScan()
    for link in Array(links.values) {
      close(link, code: ErrorCode.cancelled, message: "Module invalidated", emitDisconnect: false)
    }
  }

  // MARK: Scanning

  func startScan(service: CBUUID, resolve: @escaping Resolve, reject: @escaping Reject) {
    scanService = service
    whenPoweredOn(
      state: manager.state, waiters: stateWaiters, queue: queue,
      ready: { [weak self] in
        guard let self, let service = self.scanService else { return resolve(nil) }
        // Duplicates on: we want continuous RSSI updates while the screen is open.
        self.manager.scanForPeripherals(
          withServices: [service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        resolve(nil)
      },
      fail: reject)
  }

  func stopScan() {
    scanService = nil
    if manager.state == .poweredOn { manager.stopScan() }
  }

  // MARK: Connection

  func connect(
    deviceId: String, uuids: GattUuids, timeout: TimeInterval,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    if let existing = links[deviceId] {
      if existing.ready {
        return resolve(existing.peripheral.maximumWriteValueLength(for: .withoutResponse))
      }
      return reject(ErrorCode.busy, "Already connecting to \(deviceId)")
    }
    whenPoweredOn(
      state: manager.state, waiters: stateWaiters, queue: queue,
      ready: { [weak self] in
        self?.beginConnect(
          deviceId: deviceId, uuids: uuids, timeout: timeout, resolve: resolve, reject: reject)
      },
      fail: reject)
  }

  private func beginConnect(
    deviceId: String, uuids: GattUuids, timeout: TimeInterval,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard links[deviceId] == nil else {
      return reject(ErrorCode.busy, "Already connecting to \(deviceId)")
    }
    var peripheral = discovered[deviceId]
    if peripheral == nil, let uuid = UUID(uuidString: deviceId) {
      peripheral = manager.retrievePeripherals(withIdentifiers: [uuid]).first
    }
    guard let peripheral else {
      return reject(ErrorCode.notFound, "Unknown device \(deviceId); scan for it first")
    }

    let link = Link(peripheral: peripheral, uuids: uuids)
    link.connect = (resolve, reject)
    links[deviceId] = link
    peripheral.delegate = self

    let timeoutItem = DispatchWorkItem { [weak self, weak link] in
      guard let self, let link, link.connect != nil else { return }
      self.close(link, code: ErrorCode.timeout, message: "Connection timed out", emitDisconnect: false)
    }
    link.connectTimeout = timeoutItem
    queue.asyncAfter(deadline: .now() + max(timeout, 1), execute: timeoutItem)

    manager.connect(peripheral)
  }

  func disconnect(deviceId: String, resolve: @escaping Resolve) {
    guard let link = links[deviceId] else { return resolve(nil) }
    if !link.ready {
      // Still connecting: there may never be a didDisconnect callback, so finish now.
      close(link, code: ErrorCode.cancelled, message: "Connection cancelled", emitDisconnect: false)
      return resolve(nil)
    }
    link.disconnectWaiters.append(resolve)
    manager.cancelPeripheralConnection(link.peripheral)
  }

  // MARK: Operations

  func read(
    deviceId: String, characteristic: CBUUID, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    enqueue(deviceId: deviceId, PendingOperation(operation: .read(characteristic), resolve: resolve, reject: reject))
  }

  func write(
    deviceId: String, characteristic: CBUUID, data: Data,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    enqueue(
      deviceId: deviceId,
      PendingOperation(operation: .write(characteristic, data), resolve: resolve, reject: reject))
  }

  private func enqueue(deviceId: String, _ operation: PendingOperation) {
    guard let link = links[deviceId], link.ready else {
      return operation.reject(ErrorCode.notConnected, "Not connected to \(deviceId)")
    }
    link.queue.append(operation)
    drain(link)
  }

  /// CoreBluetooth matches responses to requests only by characteristic, so we
  /// keep exactly one operation in flight per peripheral.
  private func drain(_ link: Link) {
    while link.current == nil, !link.queue.isEmpty {
      let next = link.queue.removeFirst()
      let uuid: CBUUID
      switch next.operation {
      case .read(let u): uuid = u
      case .write(let u, _): uuid = u
      }
      guard let characteristic = link.characteristics[uuid] else {
        next.reject(ErrorCode.notFound, "Characteristic \(uuid.uuidString) not found")
        continue
      }
      link.current = next

      let timeoutItem = DispatchWorkItem { [weak self, weak link] in
        guard let self, let link, link.current != nil else { return }
        // A late response could be mistaken for the next operation's, so drop the link.
        self.close(link, code: ErrorCode.timeout, message: "GATT operation timed out", emitDisconnect: true)
      }
      link.currentTimeout = timeoutItem
      queue.asyncAfter(deadline: .now() + Self.operationTimeout, execute: timeoutItem)

      switch next.operation {
      case .read:
        link.peripheral.readValue(for: characteristic)
      case .write(_, let data):
        link.peripheral.writeValue(data, for: characteristic, type: .withResponse)
      }
    }
  }

  private func completeCurrent(_ link: Link, error: Error?, value: Any?) {
    guard let current = link.current else { return }
    link.current = nil
    link.currentTimeout?.cancel()
    link.currentTimeout = nil
    if let error {
      current.reject(ErrorCode.gatt, error.localizedDescription)
    } else {
      current.resolve(value)
    }
    drain(link)
  }

  /// Tears a link down: rejects everything pending, cancels the connection and
  /// optionally tells JS. Safe to call more than once.
  private func close(_ link: Link, code: String, message: String, emitDisconnect: Bool) {
    let deviceId = link.peripheral.identifier.uuidString
    guard links[deviceId] === link else { return }
    links.removeValue(forKey: deviceId)

    link.connectTimeout?.cancel()
    link.currentTimeout?.cancel()
    if let connect = link.connect {
      link.connect = nil
      connect.reject(code, message)
    }
    let pending = (link.current.map { [$0] } ?? []) + link.queue
    link.current = nil
    link.queue.removeAll()
    pending.forEach { $0.reject(ErrorCode.notConnected, message) }
    link.disconnectWaiters.forEach { $0(nil) }
    link.disconnectWaiters.removeAll()

    if manager.state == .poweredOn, link.peripheral.state != .disconnected {
      manager.cancelPeripheralConnection(link.peripheral)
    }
    if emitDisconnect, link.ready {
      emit("central.disconnected", ["deviceId": deviceId, "error": message])
    }
    link.ready = false
  }

  private func failConnect(_ link: Link, code: String, message: String) {
    close(link, code: code, message: message, emitDisconnect: false)
  }

  private func linkFor(_ peripheral: CBPeripheral) -> Link? {
    guard let link = links[peripheral.identifier.uuidString], link.peripheral === peripheral else {
      return nil
    }
    return link
  }

  // MARK: CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    emit("bluetoothState", ["state": bluetoothStateString(central.state)])
    stateWaiters.fire(central.state)

    if central.state == .poweredOn {
      if let service = scanService {
        central.scanForPeripherals(
          withServices: [service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
      }
    } else if central.state != .unknown {
      // Peripherals are invalidated without didDisconnect callbacks when Bluetooth goes away.
      let message = "Bluetooth is \(bluetoothStateString(central.state))"
      for link in Array(links.values) {
        close(link, code: ErrorCode.bluetoothOff, message: message, emitDisconnect: true)
      }
      discovered.removeAll()
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    // 127 means "RSSI not available".
    guard RSSI.intValue != 127 else { return }
    let deviceId = peripheral.identifier.uuidString
    discovered[deviceId] = peripheral

    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
    var serviceData: String?
    if let service = scanService,
      let dataByService = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
      let data = dataByService[service]
    {
      serviceData = data.base64EncodedString()
    }
    emit(
      "central.scanResult",
      [
        "deviceId": deviceId,
        "name": name.map { $0 as Any } ?? NSNull(),
        "rssi": RSSI.intValue,
        "serviceData": serviceData.map { $0 as Any } ?? NSNull(),
      ])
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard let link = linkFor(peripheral) else {
      // Connected after we gave up on it.
      return central.cancelPeripheralConnection(peripheral)
    }
    peripheral.discoverServices([link.uuids.service])
  }

  func centralManager(
    _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
  ) {
    guard let link = linkFor(peripheral) else { return }
    failConnect(
      link, code: ErrorCode.gatt,
      message: "Failed to connect: \(error?.localizedDescription ?? "unknown error")")
  }

  func centralManager(
    _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
  ) {
    guard let link = linkFor(peripheral) else { return }
    let message = error?.localizedDescription ?? "Disconnected"
    let requested = !link.disconnectWaiters.isEmpty && error == nil
    // A requested disconnect isn't reported as an error.
    let deviceId = peripheral.identifier.uuidString
    let wasReady = link.ready
    close(link, code: ErrorCode.notConnected, message: message, emitDisconnect: false)
    if wasReady {
      emit("central.disconnected", ["deviceId": deviceId, "error": requested ? NSNull() as Any : message as Any])
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let link = linkFor(peripheral), link.connect != nil else { return }
    if let error {
      return failConnect(link, code: ErrorCode.gatt, message: "Service discovery failed: \(error.localizedDescription)")
    }
    guard let service = peripheral.services?.first(where: { $0.uuid == link.uuids.service }) else {
      return failConnect(link, code: ErrorCode.notFound, message: "Link service not found on device")
    }
    let uuids = link.uuids
    peripheral.discoverCharacteristics([uuids.info, uuids.state, uuids.rx, uuids.tx], for: service)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
  ) {
    guard let link = linkFor(peripheral), link.connect != nil else { return }
    if let error {
      return failConnect(
        link, code: ErrorCode.gatt, message: "Characteristic discovery failed: \(error.localizedDescription)")
    }
    for characteristic in service.characteristics ?? [] {
      link.characteristics[characteristic.uuid] = characteristic
    }
    let uuids = link.uuids
    let missing = [uuids.info, uuids.state, uuids.rx, uuids.tx].filter { link.characteristics[$0] == nil }
    guard missing.isEmpty, let tx = link.characteristics[uuids.tx] else {
      return failConnect(
        link, code: ErrorCode.notFound,
        message: "Missing characteristics: \(missing.map(\.uuidString).joined(separator: ", "))")
    }
    peripheral.setNotifyValue(true, for: tx)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let link = linkFor(peripheral), characteristic.uuid == link.uuids.tx,
      let connect = link.connect
    else { return }
    if let error {
      return failConnect(
        link, code: ErrorCode.gatt, message: "Enabling notifications failed: \(error.localizedDescription)")
    }
    link.connectTimeout?.cancel()
    link.connectTimeout = nil
    link.connect = nil
    link.ready = true
    // Deliberately MTU - 3: frames that fit never turn into long (prepared) writes.
    connect.resolve(peripheral.maximumWriteValueLength(for: .withoutResponse))
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    guard let link = linkFor(peripheral) else { return }
    if characteristic.uuid == link.uuids.tx {
      guard error == nil, let value = characteristic.value else { return }
      emit(
        "central.notification",
        ["deviceId": peripheral.identifier.uuidString, "value": value.base64EncodedString()])
      return
    }
    guard let current = link.current, case .read(let uuid) = current.operation,
      uuid == characteristic.uuid
    else { return }
    completeCurrent(link, error: error, value: (characteristic.value ?? Data()).base64EncodedString())
  }

  func peripheral(
    _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    guard let link = linkFor(peripheral), let current = link.current,
      case .write(let uuid, _) = current.operation, uuid == characteristic.uuid
    else { return }
    completeCurrent(link, error: error, value: nil)
  }
}
