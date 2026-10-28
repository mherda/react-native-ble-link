package com.blelink

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import com.facebook.react.bridge.Promise
import org.json.JSONObject
import java.util.UUID

/** Scanner + GATT client for the phone role. All state is touched on [handler]'s thread only. */
@SuppressLint("MissingPermission") // checked per call via BluetoothSupport
internal class CentralController(
  private val context: Context,
  private val bluetooth: BluetoothSupport,
  private val handler: Handler,
  private val emit: (String, JSONObject) -> Unit,
) {
  private sealed class Op(val characteristic: BluetoothGattCharacteristic, val promise: Promise) {
    class Read(characteristic: BluetoothGattCharacteristic, promise: Promise) : Op(characteristic, promise)
    class Write(characteristic: BluetoothGattCharacteristic, val value: ByteArray, promise: Promise) :
      Op(characteristic, promise)
  }

  private inner class Connection(val device: BluetoothDevice, val uuids: GattUuids) {
    val deviceId: String = device.address
    var gatt: BluetoothGatt? = null
    var attempt = 0
    var mtu = 23
    var discoveryStarted = false
    var connectPromise: Promise? = null
    var disconnectPromise: Promise? = null
    var closedByUser = false
    var timeout: Runnable? = null
    val ops = ArrayDeque<Op>()
    var current: Op? = null

    val ready get() = connectPromise == null && gatt != null

    fun characteristic(uuid: UUID): BluetoothGattCharacteristic? =
      gatt?.getService(uuids.service)?.getCharacteristic(uuid)
  }

  private var scanner: BluetoothLeScanner? = null
  private var scanService: UUID? = null
  private val devices = mutableMapOf<String, BluetoothDevice>()
  private val connections = mutableMapOf<String, Connection>()

  // region Scanning

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handler.post { report(result) }
    }

    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      handler.post { results.forEach(::report) }
    }

    override fun onScanFailed(errorCode: Int) {
      handler.post {
        scanner = null
        emit("error", JSONObject().put("message", "Scan failed (code $errorCode)"))
      }
    }
  }

  private fun report(result: ScanResult) {
    val service = scanService ?: return
    val address = result.device.address
    devices[address] = result.device
    // Active scanning merges the scan response (which carries the hub ID) into scanRecord.
    val record = result.scanRecord
    val serviceData = record?.getServiceData(ParcelUuid(service))
    emit(
      "central.scanResult",
      JSONObject()
        .put("deviceId", address)
        .put("name", record?.deviceName ?: JSONObject.NULL)
        .put("rssi", result.rssi)
        .put("serviceData", serviceData?.toBase64() ?: JSONObject.NULL),
    )
  }

  fun startScan(serviceUuid: String, promise: Promise) {
    handler.post {
      val adapter = bluetooth.requireReady(promise, bluetooth::canScan) ?: return@post
      val uuid = try {
        UUID.fromString(serviceUuid)
      } catch (e: IllegalArgumentException) {
        promise.reject(Errors.NOT_FOUND, "Invalid service UUID")
        return@post
      }
      val scanner = adapter.bluetoothLeScanner
      if (scanner == null) {
        promise.reject(Errors.BLUETOOTH_OFF, "Bluetooth is turned off")
        return@post
      }
      stopScanInternal()
      // A filter is required: Android pauses unfiltered scans while the screen is off.
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(uuid)).build()
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      try {
        scanner.startScan(listOf(filter), settings, scanCallback)
        this.scanner = scanner
        scanService = uuid
        promise.resolve(null)
      } catch (e: SecurityException) {
        promise.reject(Errors.UNAUTHORIZED, e.message ?: "Missing Bluetooth permission")
      }
    }
  }

  fun stopScan(promise: Promise) {
    handler.post {
      stopScanInternal()
      promise.resolve(null)
    }
  }

  private fun stopScanInternal() {
    try {
      scanner?.stopScan(scanCallback)
    } catch (_: Exception) {
      // Throws if Bluetooth was turned off meanwhile; the scan is gone anyway.
    }
    scanner = null
  }

  // endregion

  // region Connection

  fun connect(deviceId: String, uuids: GattUuids, timeoutMs: Long, promise: Promise) {
    handler.post {
      val adapter = bluetooth.requireReady(promise, bluetooth::canConnect) ?: return@post
      connections[deviceId]?.let { existing ->
        if (existing.ready) {
          promise.resolve((existing.mtu - 3).toDouble())
        } else {
          promise.reject(Errors.GATT, "Connection to $deviceId already in progress")
        }
        return@post
      }
      val device = devices[deviceId] ?: try {
        adapter.getRemoteDevice(deviceId)
      } catch (_: IllegalArgumentException) {
        promise.reject(Errors.NOT_FOUND, "Unknown device $deviceId")
        return@post
      }
      val connection = Connection(device, uuids)
      connection.connectPromise = promise
      connections[deviceId] = connection
      val timeout = Runnable { failConnect(connection, Errors.TIMEOUT, "Connection timed out") }
      connection.timeout = timeout
      handler.postDelayed(timeout, timeoutMs)
      attemptConnect(connection)
    }
  }

  private fun attemptConnect(connection: Connection) {
    connection.attempt += 1
    connection.discoveryStarted = false
    connection.mtu = 23
    try {
      connection.gatt = connection.device.connectGatt(
        context,
        false,
        gattCallback(connection),
        BluetoothDevice.TRANSPORT_LE,
      )
      if (connection.gatt == null) failConnect(connection, Errors.GATT, "connectGatt returned null")
    } catch (e: SecurityException) {
      failConnect(connection, Errors.UNAUTHORIZED, e.message ?: "Missing Bluetooth permission")
    }
  }

  private fun failConnect(connection: Connection, code: String, message: String) {
    val promise = connection.connectPromise ?: return
    connection.connectPromise = null
    connection.timeout?.let(handler::removeCallbacks)
    connection.closedByUser = true
    closeGatt(connection)
    if (connections[connection.deviceId] === connection) connections.remove(connection.deviceId)
    promise.reject(code, message)
  }

  private fun closeGatt(connection: Connection) {
    val gatt = connection.gatt ?: return
    connection.gatt = null
    try {
      gatt.disconnect()
      gatt.close()
    } catch (_: SecurityException) {
    }
  }

  private fun onConnected(connection: Connection) {
    connection.timeout?.let(handler::removeCallbacks)
    val promise = connection.connectPromise ?: return
    connection.connectPromise = null
    promise.resolve((connection.mtu - 3).toDouble())
  }

  private fun discover(connection: Connection) {
    if (connection.discoveryStarted) return
    connection.discoveryStarted = true
    val ok = try {
      connection.gatt?.discoverServices() == true
    } catch (_: SecurityException) {
      false
    }
    if (!ok) failConnect(connection, Errors.GATT, "Service discovery could not start")
  }

  @Suppress("DEPRECATION")
  private fun enableNotifications(connection: Connection) {
    val gatt = connection.gatt ?: return
    val tx = connection.characteristic(connection.uuids.tx)
    val cccd = tx?.getDescriptor(CCCD_UUID)
    if (tx == null || cccd == null || connection.characteristic(connection.uuids.rx) == null) {
      failConnect(connection, Errors.NOT_FOUND, "BLE link service not found on device")
      return
    }
    val ok = try {
      gatt.setCharacteristicNotification(tx, true) &&
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
        } else {
          cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          gatt.writeDescriptor(cccd)
        }
    } catch (_: SecurityException) {
      false
    }
    if (!ok) failConnect(connection, Errors.GATT, "Could not enable notifications")
  }

  fun disconnect(deviceId: String, promise: Promise) {
    handler.post {
      val connection = connections[deviceId]
      when {
        connection == null -> promise.resolve(null)
        connection.connectPromise != null -> {
          failConnect(connection, Errors.NOT_CONNECTED, "Connection cancelled")
          promise.resolve(null)
        }
        else -> {
          connection.disconnectPromise = promise
          connection.closedByUser = true
          try {
            connection.gatt?.disconnect()
          } catch (_: SecurityException) {
          }
          // onConnectionStateChange isn't guaranteed after disconnect(); don't wait forever.
          handler.postDelayed({
            if (connections[deviceId] === connection) tearDown(connection, null)
          }, 1000)
        }
      }
    }
  }

  private fun tearDown(connection: Connection, error: String?) {
    if (connections[connection.deviceId] === connection) connections.remove(connection.deviceId)
    connection.gatt?.let {
      try {
        it.close()
      } catch (_: SecurityException) {
      }
    }
    connection.gatt = null
    val pending = listOfNotNull(connection.current) + connection.ops
    connection.current = null
    connection.ops.clear()
    pending.forEach { it.promise.reject(Errors.NOT_CONNECTED, "Disconnected") }
    emit(
      "central.disconnected",
      JSONObject().put("deviceId", connection.deviceId).put("error", error ?: JSONObject.NULL),
    )
    connection.disconnectPromise?.resolve(null)
    connection.disconnectPromise = null
  }

  fun shutdown() {
    handler.post {
      stopScanInternal()
      connections.values.toList().forEach { connection ->
        if (connection.connectPromise != null) {
          failConnect(connection, Errors.NOT_CONNECTED, "Module invalidated")
        } else {
          connection.closedByUser = true
          closeGatt(connection)
          tearDown(connection, null)
        }
      }
    }
  }

  // endregion

  // region Read / write

  fun read(deviceId: String, characteristicUuid: String, promise: Promise) {
    handler.post {
      val (connection, characteristic) = resolveTarget(deviceId, characteristicUuid, promise) ?: return@post
      connection.ops.addLast(Op.Read(characteristic, promise))
      pump(connection)
    }
  }

  fun write(deviceId: String, characteristicUuid: String, value: ByteArray, promise: Promise) {
    handler.post {
      val (connection, characteristic) = resolveTarget(deviceId, characteristicUuid, promise) ?: return@post
      connection.ops.addLast(Op.Write(characteristic, value, promise))
      pump(connection)
    }
  }

  private fun resolveTarget(
    deviceId: String,
    characteristicUuid: String,
    promise: Promise,
  ): Pair<Connection, BluetoothGattCharacteristic>? {
    val connection = connections[deviceId]
    if (connection == null || !connection.ready) {
      promise.reject(Errors.NOT_CONNECTED, "Not connected to $deviceId")
      return null
    }
    val uuid = try {
      UUID.fromString(characteristicUuid)
    } catch (_: IllegalArgumentException) {
      null
    }
    val characteristic = uuid?.let(connection::characteristic)
    if (characteristic == null) {
      promise.reject(Errors.NOT_FOUND, "Characteristic $characteristicUuid not found")
      return null
    }
    return connection to characteristic
  }

  // Android allows one outstanding GATT operation per connection.
  @Suppress("DEPRECATION")
  private fun pump(connection: Connection) {
    if (connection.current != null) return
    val gatt = connection.gatt ?: return
    val op = connection.ops.removeFirstOrNull() ?: return
    connection.current = op
    val started = try {
      when (op) {
        is Op.Read -> gatt.readCharacteristic(op.characteristic)
        is Op.Write -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          gatt.writeCharacteristic(
            op.characteristic,
            op.value,
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
          ) == BluetoothStatusCodes.SUCCESS
        } else {
          op.characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
          op.characteristic.value = op.value
          gatt.writeCharacteristic(op.characteristic)
        }
      }
    } catch (_: SecurityException) {
      false
    }
    if (!started) {
      connection.current = null
      op.promise.reject(Errors.GATT, "GATT operation could not start")
      pump(connection)
    }
  }

  private fun completeOp(connection: Connection, status: Int, value: ByteArray?) {
    val op = connection.current ?: return
    connection.current = null
    if (status == BluetoothGatt.GATT_SUCCESS) {
      op.promise.resolve(if (op is Op.Read) (value ?: ByteArray(0)).toBase64() else null)
    } else {
      op.promise.reject(Errors.GATT, "GATT operation failed (status $status)")
    }
    pump(connection)
  }

  // endregion

  private fun gattCallback(connection: Connection) = object : BluetoothGattCallback() {
    // Callbacks from a gatt we already closed (e.g. a failed attempt) are ignored.
    private fun current(gatt: BluetoothGatt) = connection.gatt === gatt

    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      handler.post {
        if (!current(gatt)) return@post
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
          if (connection.connectPromise == null) return@post
          // Ask for the largest MTU; discovery continues in onMtuChanged either way.
          val requested = try {
            gatt.requestMtu(517)
          } catch (_: SecurityException) {
            false
          }
          if (!requested) discover(connection)
          return@post
        }

        if (connection.connectPromise != null) {
          // Failed while connecting, typically status 133. Retry on a fresh gatt.
          closeGatt(connection)
          if (connection.attempt < MAX_CONNECT_ATTEMPTS) {
            handler.postDelayed({
              if (connection.connectPromise != null && connections[connection.deviceId] === connection) {
                attemptConnect(connection)
              }
            }, RETRY_DELAY_MS)
          } else {
            failConnect(connection, Errors.GATT, "Connection failed (status $status)")
          }
          return@post
        }

        val error = if (connection.closedByUser || status == BluetoothGatt.GATT_SUCCESS) null else "status $status"
        tearDown(connection, error)
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      handler.post {
        if (!current(gatt)) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) connection.mtu = mtu
        if (connection.connectPromise != null) discover(connection)
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      handler.post {
        if (!current(gatt) || connection.connectPromise == null) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) {
          failConnect(connection, Errors.GATT, "Service discovery failed (status $status)")
          return@post
        }
        enableNotifications(connection)
      }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      handler.post {
        if (!current(gatt) || connection.connectPromise == null) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) {
          onConnected(connection)
        } else {
          failConnect(connection, Errors.GATT, "Enabling notifications failed (status $status)")
        }
      }
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
      status: Int,
    ) {
      handler.post { if (current(gatt)) completeOp(connection, status, value) }
    }

    @Deprecated("Used below API 33")
    @Suppress("DEPRECATION")
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
      // Copy now: the characteristic's value is shared and may change before the post runs.
      val value = characteristic.value?.copyOf()
      handler.post { if (current(gatt)) completeOp(connection, status, value) }
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      handler.post { if (current(gatt)) completeOp(connection, status, null) }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      handler.post { if (current(gatt)) notification(connection, characteristic, value) }
    }

    @Deprecated("Used below API 33")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
      val value = characteristic.value?.copyOf() ?: return
      handler.post { if (current(gatt)) notification(connection, characteristic, value) }
    }
  }

  private fun notification(connection: Connection, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    if (characteristic.uuid != connection.uuids.tx) return
    emit(
      "central.notification",
      JSONObject().put("deviceId", connection.deviceId).put("value", value.toBase64()),
    )
  }

  private companion object {
    const val MAX_CONNECT_ATTEMPTS = 3
    const val RETRY_DELAY_MS = 300L
  }
}
