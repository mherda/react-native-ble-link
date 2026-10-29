package com.mherda.blelink

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.ParcelUuid
import com.facebook.react.bridge.Promise
import org.json.JSONObject

/** GATT server + advertiser for the hub role. All state is touched on [handler]'s thread only. */
@SuppressLint("MissingPermission") // checked in start() via BluetoothSupport
internal class PeripheralController(
  private val context: Context,
  private val bluetooth: BluetoothSupport,
  private val handler: Handler,
  private val emit: (String, JSONObject) -> Unit,
) {
  private class PendingNotify(val value: ByteArray, val promise: Promise)

  private var server: BluetoothGattServer? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var uuids: GattUuids? = null
  private var txCharacteristic: BluetoothGattCharacteristic? = null
  private var advertisedId: String = ""
  private var startPromise: Promise? = null
  private var advertising = false

  private var info = ByteArray(0)
  private var state = ByteArray(0)

  private val mtus = mutableMapOf<String, Int>()
  private val subscribed = mutableMapOf<String, BluetoothDevice>()
  // Centrals JS knows about (subscribed or wrote); used to emit `peripheral.disconnected` once.
  private val active = mutableSetOf<String>()
  // State bytes captured at offset 0 so a long read isn't torn by a concurrent setState().
  private val stateSnapshots = mutableMapOf<String, ByteArray>()
  private val notifyQueues = mutableMapOf<String, ArrayDeque<PendingNotify>>()
  private val notifyInFlight = mutableMapOf<String, PendingNotify>()

  fun start(uuids: GattUuids, advertisedId: String, info: ByteArray, promise: Promise) {
    handler.post {
      if (server != null || startPromise != null) teardown()

      val adapter = bluetooth.requireReady(promise, bluetooth::canConnect, bluetooth::canAdvertise) ?: return@post
      if (!adapter.isMultipleAdvertisementSupported) {
        promise.reject(Errors.UNSUPPORTED, "This device does not support BLE peripheral mode")
        return@post
      }
      val advertiser = adapter.bluetoothLeAdvertiser
      if (advertiser == null) {
        promise.reject(Errors.UNSUPPORTED, "BLE advertiser unavailable")
        return@post
      }

      try {
        val server = bluetooth.manager?.openGattServer(context, serverCallback)
        if (server == null) {
          promise.reject(Errors.GATT, "Could not open GATT server")
          return@post
        }
        this.server = server
        this.advertiser = advertiser
        this.uuids = uuids
        this.advertisedId = advertisedId
        this.info = info
        startPromise = promise

        // Advertising starts in onServiceAdded; adding a service is asynchronous.
        if (!server.addService(buildService(uuids))) {
          failStart(Errors.GATT, "Could not add GATT service")
        }
      } catch (e: SecurityException) {
        failStart(Errors.UNAUTHORIZED, e.message ?: "Missing Bluetooth permission", promise)
      }
    }
  }

  fun stop(promise: Promise?) {
    handler.post {
      teardown()
      promise?.resolve(null)
    }
  }

  fun setState(value: ByteArray) {
    handler.post { state = value }
  }

  fun notify(centralId: String, value: ByteArray, promise: Promise) {
    handler.post {
      if (server == null || !subscribed.containsKey(centralId)) {
        promise.reject(Errors.NOT_CONNECTED, "Central $centralId is not subscribed")
        return@post
      }
      notifyQueues.getOrPut(centralId) { ArrayDeque() }.addLast(PendingNotify(value, promise))
      if (!notifyInFlight.containsKey(centralId)) sendNextNotification(centralId)
    }
  }

  private fun buildService(uuids: GattUuids): BluetoothGattService {
    val service = BluetoothGattService(uuids.service, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(
      BluetoothGattCharacteristic(
        uuids.info,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ,
      ),
    )
    service.addCharacteristic(
      BluetoothGattCharacteristic(
        uuids.state,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ,
      ),
    )
    service.addCharacteristic(
      BluetoothGattCharacteristic(
        uuids.rx,
        BluetoothGattCharacteristic.PROPERTY_WRITE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
      ),
    )
    val tx = BluetoothGattCharacteristic(uuids.tx, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0)
    tx.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    service.addCharacteristic(tx)
    txCharacteristic = tx
    return service
  }

  private fun startAdvertising() {
    val advertiser = advertiser ?: return
    val uuids = uuids ?: return
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()
    // Primary packet: flags + 128-bit service UUID (21 of 31 bytes).
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceUuid(ParcelUuid(uuids.service))
      .build()
    // A custom local name would require renaming the whole adapter, so the
    // hub ID goes in the scan response as service data instead.
    val scanResponse = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceData(ParcelUuid(uuids.service), advertisedId.toByteArray(Charsets.UTF_8))
      .build()
    try {
      advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback)
    } catch (e: SecurityException) {
      failStart(Errors.UNAUTHORIZED, e.message ?: "Missing Bluetooth permission")
    }
  }

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
      handler.post {
        advertising = true
        startPromise?.resolve(null)
        startPromise = null
      }
    }

    override fun onStartFailure(errorCode: Int) {
      handler.post {
        when {
          startPromise != null -> failStart(Errors.ADVERTISE, "Advertising failed (code $errorCode)")
          errorCode == AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> {
            advertising = true
          }
          else -> emit("error", JSONObject().put("message", "Advertising restart failed (code $errorCode)"))
        }
      }
    }
  }

  // A connection ends connectable advertising on many controllers; restart it so
  // other phones can still discover the hub.
  private fun restartAdvertising() {
    if (server == null || startPromise != null) return
    try {
      if (advertising) advertiser?.stopAdvertising(advertiseCallback)
    } catch (_: Exception) {
    }
    advertising = false
    startAdvertising()
  }

  private fun failStart(code: String, message: String, promise: Promise? = startPromise) {
    startPromise = null
    teardown()
    promise?.reject(code, message)
  }

  private fun teardown() {
    startPromise?.reject(Errors.GATT, "Peripheral stopped")
    startPromise = null
    try {
      if (advertising) advertiser?.stopAdvertising(advertiseCallback)
    } catch (_: Exception) {
    }
    try {
      server?.clearServices()
      server?.close()
    } catch (_: Exception) {
    }
    advertising = false
    advertiser = null
    server = null
    txCharacteristic = null
    uuids = null
    val pending = notifyInFlight.values + notifyQueues.values.flatten()
    pending.forEach { it.promise.reject(Errors.NOT_CONNECTED, "Peripheral stopped") }
    notifyInFlight.clear()
    notifyQueues.clear()
    subscribed.clear()
    active.clear()
    mtus.clear()
    stateSnapshots.clear()
  }

  private fun maxValueLength(address: String) = (mtus[address] ?: 23) - 3

  @Suppress("DEPRECATION")
  private fun sendNextNotification(address: String) {
    val queue = notifyQueues[address] ?: return
    val next = queue.removeFirstOrNull() ?: return
    val server = server
    val tx = txCharacteristic
    val device = subscribed[address]
    if (server == null || tx == null || device == null) {
      next.promise.reject(Errors.NOT_CONNECTED, "Central $address is not subscribed")
      sendNextNotification(address)
      return
    }
    val sent = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        server.notifyCharacteristicChanged(device, tx, false, next.value) == BluetoothStatusCodes.SUCCESS
      } else {
        tx.value = next.value
        server.notifyCharacteristicChanged(device, tx, false)
      }
    } catch (_: SecurityException) {
      false
    }
    if (sent) {
      notifyInFlight[address] = next
    } else {
      next.promise.reject(Errors.GATT, "Notification could not be sent")
      sendNextNotification(address)
    }
  }

  private fun forgetCentral(address: String) {
    subscribed.remove(address)
    stateSnapshots.remove(address)
    val pending = listOfNotNull(notifyInFlight.remove(address)) + (notifyQueues.remove(address) ?: emptyList())
    pending.forEach { it.promise.reject(Errors.NOT_CONNECTED, "Central disconnected") }
    if (active.remove(address)) {
      emit("peripheral.disconnected", JSONObject().put("centralId", address))
    }
  }

  private fun respond(device: BluetoothDevice, requestId: Int, status: Int, offset: Int = 0, value: ByteArray? = null) {
    try {
      server?.sendResponse(device, requestId, status, offset, value)
    } catch (_: SecurityException) {
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      handler.post {
        if (startPromise == null) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) {
          startAdvertising()
        } else {
          failStart(Errors.GATT, "Adding GATT service failed (status $status)")
        }
      }
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      handler.post {
        if (newState == BluetoothProfile.STATE_DISCONNECTED) {
          mtus.remove(device.address)
          forgetCentral(device.address)
        }
        restartAdvertising()
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      handler.post {
        mtus[device.address] = mtu
        emit(
          "peripheral.mtu",
          JSONObject().put("centralId", device.address).put("maxValueLength", mtu - 3),
        )
      }
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      handler.post {
        val uuids = uuids
        val value = when (characteristic.uuid) {
          uuids?.info -> info
          uuids?.state -> {
            if (offset == 0) stateSnapshots[device.address] = state.copyOf()
            stateSnapshots[device.address] ?: state
          }
          else -> null
        }
        when {
          value == null -> respond(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED)
          offset > value.size -> respond(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET)
          // The stack truncates to MTU - 1; the client follows up with Read Blob at the next offset.
          else -> respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value.copyOfRange(offset, value.size))
        }
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      handler.post {
        if (characteristic.uuid != uuids?.rx) {
          if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED)
          return@post
        }
        // Centrals chunk at MTU - 3, so long (prepared) writes are never needed.
        if (preparedWrite) {
          if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED)
          return@post
        }
        if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS)
        active.add(device.address)
        emit(
          "peripheral.write",
          JSONObject().put("centralId", device.address).put("value", (value ?: ByteArray(0)).toBase64()),
        )
      }
    }

    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      handler.post { respond(device, requestId, BluetoothGatt.GATT_SUCCESS) }
    }

    override fun onDescriptorReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      descriptor: BluetoothGattDescriptor,
    ) {
      handler.post {
        if (descriptor.uuid != CCCD_UUID) {
          respond(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED)
          return@post
        }
        val value = if (subscribed.containsKey(device.address)) {
          BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        } else {
          BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        }
        respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      handler.post {
        if (descriptor.uuid != CCCD_UUID || descriptor.characteristic?.uuid != uuids?.tx) {
          if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED)
          return@post
        }
        if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS)
        val enabled = value != null && value.isNotEmpty() && (value[0].toInt() and 0x03) != 0
        val address = device.address
        if (enabled) {
          subscribed[address] = device
          active.add(address)
          emit(
            "peripheral.subscribed",
            JSONObject().put("centralId", address).put("maxValueLength", maxValueLength(address)),
          )
        } else {
          forgetCentral(address)
        }
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      handler.post {
        val address = device.address
        val sent = notifyInFlight.remove(address) ?: return@post
        if (status == BluetoothGatt.GATT_SUCCESS) {
          sent.promise.resolve(null)
        } else {
          sent.promise.reject(Errors.GATT, "Notification failed (status $status)")
        }
        sendNextNotification(address)
      }
    }
  }
}
