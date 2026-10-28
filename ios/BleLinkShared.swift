import CoreBluetooth
import Foundation

public typealias Resolve = (Any?) -> Void
public typealias Reject = (String, String) -> Void
typealias Emit = (_ type: String, _ payload: [String: Any]) -> Void

enum ErrorCode {
  static let bluetoothOff = "E_BLUETOOTH_OFF"
  static let unauthorized = "E_UNAUTHORIZED"
  static let unsupported = "E_UNSUPPORTED"
  static let notConnected = "E_NOT_CONNECTED"
  static let timeout = "E_TIMEOUT"
  static let notFound = "E_NOT_FOUND"
  static let gatt = "E_GATT"
  static let invalidArgument = "E_INVALID_ARGUMENT"
  static let cancelled = "E_CANCELLED"
  static let busy = "E_BUSY"
}

/// Maps to the `BluetoothState` union in src/transport/nativeEvents.ts.
func bluetoothStateString(_ state: CBManagerState) -> String {
  switch state {
  case .resetting: return "resetting"
  case .unsupported: return "unsupported"
  case .unauthorized: return "unauthorized"
  case .poweredOff: return "poweredOff"
  case .poweredOn: return "poweredOn"
  case .unknown: return "unknown"
  @unknown default: return "unknown"
  }
}

/// Rejection for a state that will not become `.poweredOn` on its own.
func stateError(_ state: CBManagerState) -> (code: String, message: String) {
  switch state {
  case .unauthorized: return (ErrorCode.unauthorized, "Bluetooth permission denied")
  case .unsupported: return (ErrorCode.unsupported, "Bluetooth LE is not supported on this device")
  case .poweredOff: return (ErrorCode.bluetoothOff, "Bluetooth is turned off")
  default: return (ErrorCode.bluetoothOff, "Bluetooth is not ready (\(bluetoothStateString(state)))")
  }
}

/// `CBUUID(string:)` raises an ObjC exception on malformed input, so validate first.
func parseUUID(_ string: String) -> CBUUID? {
  if UUID(uuidString: string) != nil { return CBUUID(string: string) }
  let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
  if (string.count == 4 || string.count == 8),
    string.unicodeScalars.allSatisfy({ hex.contains($0) })
  {
    return CBUUID(string: string)
  }
  return nil
}

struct GattUuids {
  let service: CBUUID
  let info: CBUUID
  let state: CBUUID
  let rx: CBUUID
  let tx: CBUUID

  init?(_ dict: [String: String]) {
    guard let service = dict["service"].flatMap(parseUUID),
      let info = dict["info"].flatMap(parseUUID),
      let state = dict["state"].flatMap(parseUUID),
      let rx = dict["rx"].flatMap(parseUUID),
      let tx = dict["tx"].flatMap(parseUUID)
    else { return nil }
    self.service = service
    self.info = info
    self.state = state
    self.rx = rx
    self.tx = tx
  }
}

/// Callbacks waiting for a CBManager to leave `.unknown` / `.resetting`.
/// Must only be used from the CoreBluetooth queue.
final class ManagerStateWaiters {
  private var waiters: [(id: Int, onState: (CBManagerState) -> Void)] = []
  private var nextId = 0

  func add(
    on queue: DispatchQueue,
    timeout: TimeInterval,
    onState: @escaping (CBManagerState) -> Void,
    onTimeout: @escaping () -> Void
  ) {
    let id = nextId
    nextId += 1
    waiters.append((id, onState))
    queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
      guard let self, let index = self.waiters.firstIndex(where: { $0.id == id }) else { return }
      self.waiters.remove(at: index)
      onTimeout()
    }
  }

  func fire(_ state: CBManagerState) {
    guard state != .unknown, state != .resetting else { return }
    let current = waiters
    waiters = []
    current.forEach { $0.onState(state) }
  }
}

/// Runs `ready` once the manager is powered on, or `fail` if it cannot get there.
func whenPoweredOn(
  state: CBManagerState,
  waiters: ManagerStateWaiters,
  queue: DispatchQueue,
  timeout: TimeInterval = 5,
  ready: @escaping () -> Void,
  fail: @escaping Reject
) {
  switch state {
  case .poweredOn:
    ready()
  case .unknown, .resetting:
    waiters.add(
      on: queue, timeout: timeout,
      onState: { newState in
        if newState == .poweredOn {
          ready()
        } else {
          let error = stateError(newState)
          fail(error.code, error.message)
        }
      },
      onTimeout: { fail(ErrorCode.bluetoothOff, "Timed out waiting for Bluetooth to power on") })
  default:
    let error = stateError(state)
    fail(error.code, error.message)
  }
}
