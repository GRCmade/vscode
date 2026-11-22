/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

namespace {

struct Request {
	napi_deferred result;
	napi_async_work work;
	const char *permission = "unknown";
};

void Read(napi_env, void *data) {
	@autoreleasepool {
		@try {
			dispatch_semaphore_t ready = dispatch_semaphore_create(0);
			__block const char *permission = "unknown";
			// Query in the Electron main process so macOS uses Studio's identity, not a helper's.
			[[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
				if (settings) {
					switch (settings.authorizationStatus) {
						case UNAuthorizationStatusAuthorized:
						case UNAuthorizationStatusProvisional: permission = "granted"; break;
						case UNAuthorizationStatusDenied: permission = "denied"; break;
						case UNAuthorizationStatusNotDetermined: permission = "not-determined"; break;
						default: break;
					}
				}
				dispatch_semaphore_signal(ready);
			}];
			if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0) {
				static_cast<Request *>(data)->permission = permission;
			}
		} @catch (NSException *) {
			// An invalid or unpackaged application identity cannot query the system.
		}
	}
}

void Complete(napi_env env, napi_status, void *data) {
	auto *request = static_cast<Request *>(data);
	napi_value permission;
	if (napi_create_string_utf8(env, request->permission, NAPI_AUTO_LENGTH, &permission) == napi_ok) {
		napi_resolve_deferred(env, request->result, permission);
	}
	napi_delete_async_work(env, request->work);
	delete request;
}

napi_value GetPermission(napi_env env, napi_callback_info) {
	auto *request = new Request{};
	napi_value promise, resource;
	if (napi_create_promise(env, &request->result, &promise) != napi_ok ||
		napi_create_string_utf8(env, "StudioNotificationPermission", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
		napi_create_async_work(env, nullptr, resource, Read, Complete, request, &request->work) != napi_ok ||
		napi_queue_async_work(env, request->work) != napi_ok) {
		if (request->work) { napi_delete_async_work(env, request->work); }
		delete request;
		napi_throw_error(env, nullptr, "Could not query notification permission");
		return nullptr;
	}
	return promise;
}

napi_value Init(napi_env env, napi_value exports) {
	napi_value fn;
	if (napi_create_function(env, "getPermission", NAPI_AUTO_LENGTH, GetPermission, nullptr, &fn) == napi_ok) {
		napi_set_named_property(env, exports, "getPermission", fn);
	}
	return exports;
}

}

NAPI_MODULE(studio_notification_permission, Init)
