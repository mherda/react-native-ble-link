#import "BleLink.h"

#if __has_include("BleLink/BleLink-Swift.h")
#import "BleLink/BleLink-Swift.h"
#else
#import "BleLink-Swift.h"
#endif

using RejectBlock = void (^)(NSString *, NSString *);

static RejectBlock wrapReject(RCTPromiseRejectBlock reject)
{
  return ^(NSString *code, NSString *message) {
    reject(code, message, nil);
  };
}

static NSDictionary<NSString *, NSString *> *uuidsToDictionary(JS::NativeBleLink::GattUuids &uuids)
{
  return @{
    @"service" : uuids.service(),
    @"info" : uuids.info(),
    @"state" : uuids.state(),
    @"rx" : uuids.rx(),
    @"tx" : uuids.tx(),
  };
}

@implementation BleLink {
  BleLinkCore *_core;
}

RCT_EXPORT_MODULE(BleLink)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _core = [BleLinkCore new];
    __weak BleLink *weakSelf = self;
    _core.onEvent = ^(NSString *type, NSString *payload) {
      [weakSelf emitOnEvent:@{@"type" : type, @"payload" : payload}];
    };
  }
  return self;
}

- (void)invalidate
{
  [_core invalidate];
}

#pragma mark - Shared

- (void)getBluetoothState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_core getBluetoothState:resolve reject:wrapReject(reject)];
}

- (void)enableBluetooth:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_core enableBluetooth:resolve reject:wrapReject(reject)];
}

- (void)isPeripheralSupported:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_core isPeripheralSupported:resolve reject:wrapReject(reject)];
}

#pragma mark - Peripheral

- (void)peripheralStart:(JS::NativeBleLink::GattUuids &)uuids
           advertisedId:(NSString *)advertisedId
                   info:(NSString *)info
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [_core peripheralStart:uuidsToDictionary(uuids)
            advertisedId:advertisedId
                    info:info
                 resolve:resolve
                  reject:wrapReject(reject)];
}

- (void)peripheralStop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_core peripheralStop:resolve reject:wrapReject(reject)];
}

- (void)peripheralSetState:(NSString *)value
{
  [_core peripheralSetState:value];
}

- (void)peripheralNotify:(NSString *)centralId
                   value:(NSString *)value
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  [_core peripheralNotify:centralId value:value resolve:resolve reject:wrapReject(reject)];
}

#pragma mark - Central

- (void)centralStartScan:(NSString *)serviceUuid
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  [_core centralStartScan:serviceUuid resolve:resolve reject:wrapReject(reject)];
}

- (void)centralStopScan:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_core centralStopScan:resolve reject:wrapReject(reject)];
}

- (void)centralConnect:(NSString *)deviceId
                 uuids:(JS::NativeBleLink::GattUuids &)uuids
             timeoutMs:(double)timeoutMs
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [_core centralConnect:deviceId
                  uuids:uuidsToDictionary(uuids)
              timeoutMs:timeoutMs
                resolve:resolve
                 reject:wrapReject(reject)];
}

- (void)centralDisconnect:(NSString *)deviceId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [_core centralDisconnect:deviceId resolve:resolve reject:wrapReject(reject)];
}

- (void)centralRead:(NSString *)deviceId
    characteristicUuid:(NSString *)characteristicUuid
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [_core centralRead:deviceId characteristicUuid:characteristicUuid resolve:resolve reject:wrapReject(reject)];
}

- (void)centralWrite:(NSString *)deviceId
    characteristicUuid:(NSString *)characteristicUuid
                 value:(NSString *)value
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [_core centralWrite:deviceId
      characteristicUuid:characteristicUuid
                   value:value
                 resolve:resolve
                  reject:wrapReject(reject)];
}

#pragma mark - TurboModule

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeBleLinkSpecJSI>(params);
}

@end
