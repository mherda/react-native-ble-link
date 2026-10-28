require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "BleLink"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"] || "https://www.npmjs.com/package/react-native-ble-link"
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  # Apps install the pod from node_modules (:path), so :git is only informational.
  s.source       = { :git => (package.dig("repository", "url") || "https://example.invalid/react-native-ble-link.git"), :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}"
  # BleLink.h pulls in C++ codegen headers; keep it out of the umbrella header
  # so the Swift half of the module can still be compiled.
  s.private_header_files = "ios/**/*.h"
  s.swift_version = "5.0"
  s.frameworks = "CoreBluetooth"

  # Must be set before install_modules_dependencies, which merges into it.
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)
end
