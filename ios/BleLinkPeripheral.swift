import CoreBluetooth
import Foundation

/// Hub (peripheral) role: advertises the link service and hosts the GATT server.
/// All methods must be called on `queue` (the manager's delegate queue).
final class BleLinkPeripheral: NSObject, CBPeripheralManagerDelegate {
  private struct PendingNotify {
    let centralId: String
    let data: Data
    let resolve: Resolve
    let reject: Reject
  }

  private let queue: DispatchQueue
  private let emit: Emit
  private var manager: CBPeripheralManager!
  private let stateWaiters = ManagerStateWaiters()

  private var uuids: GattUuids?
  private var advertisedId = ""
  private var info = Data()
  private var state = Data()
  /// Wanted by JS; used to restore the service after Bluetooth is toggled.
  private var shouldRun = false

  private var pendingStart: (resolve: Resolve, reject: Reject)?
  private var startTimeout: DispatchWorkItem?

  private var txCharacteristic: CBMutableCharacteristic?
  /// Centrals subscribed to tx, keyed by `identifier.uuidString`.
  private var centrals: [String: CBCentral] = [:]
  /// State bytes captured at offset 0 of a read, so long reads stay consistent
  /// even if the state changes between ATT Read Blob requests.
  private var stateSnapshots: [String: Data] = [:]
  private var notifyQueue: [PendingNotify] = []

  init(queue: DispatchQueue, emit: @escaping Emit) {
    self.queue = queue
    self.emit = emit
    super.init()
    manager = CBPeripheralManager(delegate: self, queue: queue)
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

  // MARK: Commands

  func start(
    uuids: GattUuids, advertisedId: String, info: Data,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    failPendingStart(ErrorCode.cancelled, "Superseded by a new start call")
    self.uuids = uuids
    self.advertisedId = advertisedId
    self.info = info
    shouldRun = true
    pendingStart = (resolve, reject)

    let timeout = DispatchWorkItem { [weak self] in
      self?.failPendingStart(ErrorCode.timeout, "Timed out starting the peripheral")
    }
    startTimeout = timeout
    queue.asyncAfter(deadline: .now() + 10, execute: timeout)

    whenPoweredOn(
      state: manager.state, waiters: stateWaiters, queue: queue,
      ready: { [weak self] in self?.setUpService() },
      fail: { [weak self] code, message in self?.failPendingStart(code, message) })
  }

  func stop() {
    shouldRun = false
    failPendingStart(ErrorCode.cancelled, "Peripheral stopped")
    tearDown(reason: "Peripheral stopped")
  }

  func shutdown() {
    stop()
  }

  func setState(_ data: Data) {
    state = data
  }

  func notify(centralId: String, data: Data, resolve: @escaping Resolve, reject: @escaping Reject) {
    guard let central = centrals[centralId], txCharacteristic != nil else {
      return reject(ErrorCode.notConnected, "Central \(centralId) is not subscribed")
    }
    guard data.count <= central.maximumUpdateValueLength else {
      return reject(
        ErrorCode.gatt,
        "Value of \(data.count) bytes exceeds maximumUpdateValueLength \(central.maximumUpdateValueLength)"
      )
    }
    notifyQueue.append(PendingNotify(centralId: centralId, data: data, resolve: resolve, reject: reject))
    drainNotifyQueue()
  }

  // MARK: Internals

  private func setUpService() {
    guard let uuids, shouldRun else { return }
    manager.stopAdvertising()
    manager.removeAllServices()
    clearCentrals(reason: nil)

    let info = CBMutableCharacteristic(
      type: uuids.info, properties: [.read], value: nil, permissions: [.readable])
    // value must stay nil so every read reaches didReceiveRead and sees the latest state.
    let state = CBMutableCharacteristic(
      type: uuids.state, properties: [.read], value: nil, permissions: [.readable])
    let rx = CBMutableCharacteristic(
      type: uuids.rx, properties: [.write], value: nil, permissions: [.writeable])
    let tx = CBMutableCharacteristic(
      type: uuids.tx, properties: [.notify], value: nil, permissions: [.readable])
    txCharacteristic = tx

    let service = CBMutableService(type: uuids.service, primary: true)
    service.characteristics = [info, state, rx, tx]
    manager.add(service)
  }

  private func tearDown(reason: String) {
    if manager.isAdvertising { manager.stopAdvertising() }
    manager.removeAllServices()
    txCharacteristic = nil
    clearCentrals(reason: reason)
  }

  /// Forgets all centrals, failing their pending notifications.
  private func clearCentrals(reason: String?) {
    let ids = Array(centrals.keys)
    centrals.removeAll()
    stateSnapshots.removeAll()
    let pending = notifyQueue
    notifyQueue.removeAll()
    pending.forEach { $0.reject(ErrorCode.notConnected, reason ?? "Service restarted") }
    ids.forEach { emit("peripheral.disconnected", ["centralId": $0]) }
  }

  private func failPendingStart(_ code: String, _ message: String) {
    startTimeout?.cancel()
    startTimeout = nil
    guard let pending = pendingStart else { return }
    pendingStart = nil
    pending.reject(code, message)
  }

  private func resolvePendingStart() {
    startTimeout?.cancel()
    startTimeout = nil
    guard let pending = pendingStart else { return }
    pendingStart = nil
    pending.resolve(nil)
  }

  private func drainNotifyQueue() {
    guard let tx = txCharacteristic else { return }
    while let next = notifyQueue.first {
      guard let central = centrals[next.centralId] else {
        notifyQueue.removeFirst()
        next.reject(ErrorCode.notConnected, "Central \(next.centralId) is not subscribed")
        continue
      }
      // false = transmit queue full; peripheralManagerIsReady(toUpdateSubscribers:) resumes us.
      guard manager.updateValue(next.data, for: tx, onSubscribedCentrals: [central]) else { return }
      notifyQueue.removeFirst()
      next.resolve(nil)
    }
  }

  // MARK: CBPeripheralManagerDelegate

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    emit("bluetoothState", ["state": bluetoothStateString(peripheral.state)])
    stateWaiters.fire(peripheral.state)

    if peripheral.state == .poweredOn {
      // Services are dropped when Bluetooth goes off; restore them when it comes back.
      if shouldRun, pendingStart == nil, txCharacteristic == nil { setUpService() }
    } else if peripheral.state != .unknown {
      txCharacteristic = nil
      clearCentrals(reason: "Bluetooth is \(bluetoothStateString(peripheral.state))")
      if pendingStart != nil, peripheral.state != .resetting {
        let error = stateError(peripheral.state)
        failPendingStart(error.code, error.message)
      }
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error {
      failPendingStart(ErrorCode.gatt, "Failed to add service: \(error.localizedDescription)")
      return
    }
    var advertisement: [String: Any] = [CBAdvertisementDataServiceUUIDsKey: [service.uuid]]
    if !advertisedId.isEmpty { advertisement[CBAdvertisementDataLocalNameKey] = advertisedId }
    peripheral.startAdvertising(advertisement)
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if let error {
      failPendingStart(ErrorCode.gatt, "Failed to start advertising: \(error.localizedDescription)")
    } else {
      resolvePendingStart()
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard let uuids else {
      return peripheral.respond(to: request, withResult: .attributeNotFound)
    }
    let centralId = request.central.identifier.uuidString
    let data: Data
    switch request.characteristic.uuid {
    case uuids.info:
      data = info
    case uuids.state:
      if request.offset == 0 { stateSnapshots[centralId] = state }
      data = stateSnapshots[centralId] ?? state
    default:
      return peripheral.respond(to: request, withResult: .readNotPermitted)
    }
    guard request.offset <= data.count else {
      return peripheral.respond(to: request, withResult: .invalidOffset)
    }
    // CoreBluetooth trims to the MTU; the central follows up with Read Blob at the next offset.
    request.value = data.subdata(in: request.offset..<data.count)
    peripheral.respond(to: request, withResult: .success)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    guard let first = requests.first else { return }
    guard let uuids, requests.allSatisfy({ $0.characteristic.uuid == uuids.rx }) else {
      return peripheral.respond(to: first, withResult: .writeNotPermitted)
    }
    // A single respond call answers the whole batch (per Apple docs).
    peripheral.respond(to: first, withResult: .success)

    // Clients write one frame per request, but if a central ever used a long
    // (prepared) write, reassemble consecutive offsets into a single value.
    var pending: (centralId: String, data: Data)?
    func flush() {
      guard let item = pending else { return }
      emit("peripheral.write", ["centralId": item.centralId, "value": item.data.base64EncodedString()])
      pending = nil
    }
    for request in requests {
      let centralId = request.central.identifier.uuidString
      let value = request.value ?? Data()
      if request.offset > 0, var current = pending, current.centralId == centralId {
        current.data.append(value)
        pending = current
      } else {
        flush()
        pending = (centralId, value)
      }
    }
    flush()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager, central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == uuids?.tx else { return }
    let centralId = central.identifier.uuidString
    centrals[centralId] = central
    emit(
      "peripheral.subscribed",
      ["centralId": centralId, "maxValueLength": central.maximumUpdateValueLength])
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager, central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == uuids?.tx else { return }
    // iOS has no peripheral-side disconnect callback; unsubscribing from tx is our signal.
    let centralId = central.identifier.uuidString
    guard centrals.removeValue(forKey: centralId) != nil else { return }
    stateSnapshots.removeValue(forKey: centralId)
    let (dropped, kept) = notifyQueue.partitioned { $0.centralId == centralId }
    notifyQueue = kept
    dropped.forEach { $0.reject(ErrorCode.notConnected, "Central \(centralId) disconnected") }
    emit("peripheral.disconnected", ["centralId": centralId])
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    drainNotifyQueue()
  }
}

extension Array {
  fileprivate func partitioned(by predicate: (Element) -> Bool) -> (matching: [Element], rest: [Element]) {
    var matching: [Element] = []
    var rest: [Element] = []
    for element in self {
      if predicate(element) { matching.append(element) } else { rest.append(element) }
    }
    return (matching, rest)
  }
}
