package com.mherda.blelink

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import java.util.UUID

internal object Errors {
  const val BLUETOOTH_OFF = "E_BLUETOOTH_OFF"
  const val UNAUTHORIZED = "E_UNAUTHORIZED"
  const val UNSUPPORTED = "E_UNSUPPORTED"
  const val NOT_CONNECTED = "E_NOT_CONNECTED"
  const val TIMEOUT = "E_TIMEOUT"
  const val NOT_FOUND = "E_NOT_FOUND"
  const val GATT = "E_GATT"
  const val ADVERTISE = "E_ADVERTISE"
  const val NO_ACTIVITY = "E_NO_ACTIVITY"
  const val BUSY = "E_BUSY"
}

internal val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

internal data class GattUuids(
  val service: UUID,
  val info: UUID,
  val state: UUID,
  val rx: UUID,
  val tx: UUID,
) {
  companion object {
    fun from(map: ReadableMap) = GattUuids(
      service = UUID.fromString(map.getString("service")),
      info = UUID.fromString(map.getString("info")),
      state = UUID.fromString(map.getString("state")),
      rx = UUID.fromString(map.getString("rx")),
      tx = UUID.fromString(map.getString("tx")),
    )
  }
}

internal fun ByteArray.toBase64(): String = Base64.encodeToString(this, Base64.NO_WRAP)

internal fun String.fromBase64(): ByteArray = Base64.decode(this, Base64.DEFAULT)

internal class BluetoothSupport(private val context: Context) {
  val manager: BluetoothManager? = context.getSystemService(BluetoothManager::class.java)
  val adapter: BluetoothAdapter? get() = manager?.adapter

  private fun granted(permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  fun canConnect() = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || granted(Manifest.permission.BLUETOOTH_CONNECT)

  fun canAdvertise() = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || granted(Manifest.permission.BLUETOOTH_ADVERTISE)

  // Before Android 12, scanning silently returns nothing without location permission.
  fun canScan() =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      granted(Manifest.permission.BLUETOOTH_SCAN)
    } else {
      granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
    }

  fun state(): String {
    val adapter = adapter ?: return "unsupported"
    if (!canConnect()) return "unauthorized"
    return when (adapter.state) {
      BluetoothAdapter.STATE_ON -> "poweredOn"
      BluetoothAdapter.STATE_OFF -> "poweredOff"
      BluetoothAdapter.STATE_TURNING_ON, BluetoothAdapter.STATE_TURNING_OFF -> "resetting"
      else -> "unknown"
    }
  }

  /**
   * Returns the adapter if it exists, the checks pass and Bluetooth is on;
   * otherwise rejects [promise] and returns null.
   */
  fun requireReady(promise: Promise, vararg checks: () -> Boolean): BluetoothAdapter? {
    val adapter = adapter
    if (adapter == null) {
      promise.reject(Errors.UNSUPPORTED, "Bluetooth is not available on this device")
      return null
    }
    if (checks.any { !it() }) {
      promise.reject(Errors.UNAUTHORIZED, "Missing Bluetooth permission")
      return null
    }
    if (!adapter.isEnabled) {
      promise.reject(Errors.BLUETOOTH_OFF, "Bluetooth is turned off")
      return null
    }
    return adapter
  }
}
