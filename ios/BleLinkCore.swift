import CoreBluetooth
import Foundation

/// Entry point used by BleLink.mm. Owns the CoreBluetooth queue and creates the
/// peripheral / central roles lazily, so the hub app never instantiates a
/// CBCentralManager (and vice versa) unless it actually uses that role.
@objc(BleLinkCore)
public final class BleLinkCore: NSObject {
  @objc public var onEvent: ((String, String) -> Void)?

  private let queue = DispatchQueue(label: "com.blelink.corebluetooth")
  private var peripheralRole: BleLinkPeripheral?
  private var centralRole: BleLinkCentral?

  private lazy var emit: Emit = { [weak self] type, payload in
    guard let self, let onEvent = self.onEvent else { return }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    else { return }
    onEvent(type, json)
  }

  private func peripheral() -> BleLinkPeripheral {
    if let role = peripheralRole { return role }
    let role = BleLinkPeripheral(queue: queue, emit: emit)
    peripheralRole = role
    return role
  }

  private func central() -> BleLinkCentral {
    if let role = centralRole { return role }
    let role = BleLinkCentral(queue: queue, emit: emit)
    centralRole = role
    return role
  }

  // MARK: Shared

  @objc(getBluetoothState:reject:)
  public func getBluetoothState(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    queue.async {
      if let role = self.peripheralRole {
        role.currentState(resolve)
      } else {
        self.central().currentState(resolve)
      }
    }
  }

  /// iOS has no API to turn Bluetooth on, so this only reports whether it is on.
  @objc(enableBluetooth:reject:)
  public func enableBluetooth(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    getBluetoothState({ state in resolve((state as? String) == "poweredOn") }, reject: reject)
  }

  @objc(isPeripheralSupported:reject:)
  public func isPeripheralSupported(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    resolve(true)
  }

  @objc public func invalidate() {
    queue.async {
      self.peripheralRole?.shutdown()
      self.centralRole?.shutdown()
    }
  }

  // MARK: Peripheral

  @objc(peripheralStart:advertisedId:info:resolve:reject:)
  public func peripheralStart(
    _ uuids: [String: String], advertisedId: String, info: String,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let gatt = GattUuids(uuids) else {
      return reject(ErrorCode.invalidArgument, "Invalid GATT UUIDs")
    }
    guard let infoData = Data(base64Encoded: info) else {
      return reject(ErrorCode.invalidArgument, "info is not valid base64")
    }
    queue.async {
      self.peripheral().start(
        uuids: gatt, advertisedId: advertisedId, info: infoData, resolve: resolve, reject: reject)
    }
  }

  @objc(peripheralStop:reject:)
  public func peripheralStop(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    queue.async {
      self.peripheralRole?.stop()
      resolve(nil)
    }
  }

  @objc(peripheralSetState:)
  public func peripheralSetState(_ value: String) {
    guard let data = Data(base64Encoded: value) else { return }
    queue.async { self.peripheral().setState(data) }
  }

  @objc(peripheralNotify:value:resolve:reject:)
  public func peripheralNotify(
    _ centralId: String, value: String, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let data = Data(base64Encoded: value) else {
      return reject(ErrorCode.invalidArgument, "value is not valid base64")
    }
    queue.async {
      guard let role = self.peripheralRole else {
        return reject(ErrorCode.notConnected, "Peripheral is not running")
      }
      role.notify(centralId: centralId, data: data, resolve: resolve, reject: reject)
    }
  }

  // MARK: Central

  @objc(centralStartScan:resolve:reject:)
  public func centralStartScan(
    _ serviceUuid: String, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let uuid = parseUUID(serviceUuid) else {
      return reject(ErrorCode.invalidArgument, "Invalid service UUID")
    }
    queue.async { self.central().startScan(service: uuid, resolve: resolve, reject: reject) }
  }

  @objc(centralStopScan:reject:)
  public func centralStopScan(_ resolve: @escaping Resolve, reject: @escaping Reject) {
    queue.async {
      self.centralRole?.stopScan()
      resolve(nil)
    }
  }

  @objc(centralConnect:uuids:timeoutMs:resolve:reject:)
  public func centralConnect(
    _ deviceId: String, uuids: [String: String], timeoutMs: Double,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let gatt = GattUuids(uuids) else {
      return reject(ErrorCode.invalidArgument, "Invalid GATT UUIDs")
    }
    queue.async {
      self.central().connect(
        deviceId: deviceId, uuids: gatt, timeout: timeoutMs / 1000, resolve: resolve,
        reject: reject)
    }
  }

  @objc(centralDisconnect:resolve:reject:)
  public func centralDisconnect(
    _ deviceId: String, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    queue.async {
      guard let role = self.centralRole else { return resolve(nil) }
      role.disconnect(deviceId: deviceId, resolve: resolve)
    }
  }

  @objc(centralRead:characteristicUuid:resolve:reject:)
  public func centralRead(
    _ deviceId: String, characteristicUuid: String,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let uuid = parseUUID(characteristicUuid) else {
      return reject(ErrorCode.invalidArgument, "Invalid characteristic UUID")
    }
    queue.async {
      guard let role = self.centralRole else {
        return reject(ErrorCode.notConnected, "Not connected to \(deviceId)")
      }
      role.read(deviceId: deviceId, characteristic: uuid, resolve: resolve, reject: reject)
    }
  }

  @objc(centralWrite:characteristicUuid:value:resolve:reject:)
  public func centralWrite(
    _ deviceId: String, characteristicUuid: String, value: String,
    resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let uuid = parseUUID(characteristicUuid) else {
      return reject(ErrorCode.invalidArgument, "Invalid characteristic UUID")
    }
    guard let data = Data(base64Encoded: value) else {
      return reject(ErrorCode.invalidArgument, "value is not valid base64")
    }
    queue.async {
      guard let role = self.centralRole else {
        return reject(ErrorCode.notConnected, "Not connected to \(deviceId)")
      }
      role.write(
        deviceId: deviceId, characteristic: uuid, data: data, resolve: resolve, reject: reject)
    }
  }
}
