package com.blelink

import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject

class BleLinkModule(reactContext: ReactApplicationContext) : NativeBleLinkSpec(reactContext) {
  // All Bluetooth state lives on this thread; GATT callbacks arrive on binder
  // threads and are posted here.
  private val thread = HandlerThread("BleLink").apply { start() }
  private val handler = Handler(thread.looper)
  private val bluetooth = BluetoothSupport(reactContext)
  private val peripheral = PeripheralController(reactContext, bluetooth, handler, ::emit)
  private val central = CentralController(reactContext, bluetooth, handler, ::emit)

  private var stateReceiver: BroadcastReceiver? = null

  private fun emit(type: String, payload: JSONObject) {
    emitOnEvent(
      Arguments.createMap().apply {
        putString("type", type)
        putString("payload", payload.toString())
      },
    )
  }

  private fun ensureStateReceiver() {
    if (stateReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == BluetoothAdapter.ACTION_STATE_CHANGED) {
          emit("bluetoothState", JSONObject().put("state", bluetooth.state()))
        }
      }
    }
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactApplicationContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      reactApplicationContext.registerReceiver(receiver, filter)
    }
    stateReceiver = receiver
  }

  override fun getBluetoothState(promise: Promise) {
    ensureStateReceiver()
    promise.resolve(bluetooth.state())
  }

  override fun isPeripheralSupported(promise: Promise) {
    ensureStateReceiver()
    val adapter = bluetooth.adapter
    promise.resolve(adapter != null && adapter.isMultipleAdvertisementSupported)
  }

  private var enablePromise: Promise? = null

  private val enableResultListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != REQUEST_ENABLE_BT) return
      enablePromise?.resolve(resultCode == Activity.RESULT_OK)
      enablePromise = null
    }
  }

  init {
    reactContext.addActivityEventListener(enableResultListener)
  }

  override fun enableBluetooth(promise: Promise) {
    ensureStateReceiver()
    val adapter = bluetooth.adapter
    if (adapter == null) {
      promise.resolve(false)
      return
    }
    if (adapter.isEnabled) {
      promise.resolve(true)
      return
    }
    // The system dialog needs BLUETOOTH_CONNECT on Android 12+.
    if (!bluetooth.canConnect()) {
      promise.reject(Errors.UNAUTHORIZED, "BLUETOOTH_CONNECT permission not granted")
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject(Errors.NO_ACTIVITY, "No foreground activity to show the dialog from")
      return
    }
    if (enablePromise != null) {
      promise.reject(Errors.BUSY, "The Bluetooth dialog is already showing")
      return
    }
    enablePromise = promise
    try {
      @Suppress("MissingPermission")
      activity.startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE_BT)
    } catch (e: Exception) {
      enablePromise = null
      promise.reject(Errors.UNSUPPORTED, "Could not show the Bluetooth dialog: ${e.message}")
    }
  }

  override fun peripheralStart(uuids: ReadableMap, advertisedId: String, info: String, promise: Promise) {
    ensureStateReceiver()
    val parsed = try {
      GattUuids.from(uuids)
    } catch (e: Exception) {
      promise.reject(Errors.GATT, "Invalid UUIDs: ${e.message}")
      return
    }
    peripheral.start(parsed, advertisedId, info.fromBase64(), promise)
  }

  override fun peripheralStop(promise: Promise) {
    peripheral.stop(promise)
  }

  override fun peripheralSetState(value: String) {
    peripheral.setState(value.fromBase64())
  }

  override fun peripheralNotify(centralId: String, value: String, promise: Promise) {
    peripheral.notify(centralId, value.fromBase64(), promise)
  }

  override fun centralStartScan(serviceUuid: String, promise: Promise) {
    ensureStateReceiver()
    central.startScan(serviceUuid, promise)
  }

  override fun centralStopScan(promise: Promise) {
    central.stopScan(promise)
  }

  override fun centralConnect(deviceId: String, uuids: ReadableMap, timeoutMs: Double, promise: Promise) {
    ensureStateReceiver()
    val parsed = try {
      GattUuids.from(uuids)
    } catch (e: Exception) {
      promise.reject(Errors.GATT, "Invalid UUIDs: ${e.message}")
      return
    }
    central.connect(deviceId, parsed, timeoutMs.toLong(), promise)
  }

  override fun centralDisconnect(deviceId: String, promise: Promise) {
    central.disconnect(deviceId, promise)
  }

  override fun centralRead(deviceId: String, characteristicUuid: String, promise: Promise) {
    central.read(deviceId, characteristicUuid, promise)
  }

  override fun centralWrite(deviceId: String, characteristicUuid: String, value: String, promise: Promise) {
    central.write(deviceId, characteristicUuid, value.fromBase64(), promise)
  }

  override fun invalidate() {
    stateReceiver?.let {
      try {
        reactApplicationContext.unregisterReceiver(it)
      } catch (_: IllegalArgumentException) {
      }
    }
    stateReceiver = null
    reactApplicationContext.removeActivityEventListener(enableResultListener)
    enablePromise?.resolve(false)
    enablePromise = null
    peripheral.stop(null)
    central.shutdown()
    // Let the queued teardown run before the looper exits.
    handler.post { thread.quitSafely() }
    super.invalidate()
  }

  companion object {
    const val NAME = "BleLink"
    private const val REQUEST_ENABLE_BT = 0xB1E
  }
}
