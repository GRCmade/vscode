/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI, UriDto } from '../../../base/common/uri.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { IStateReadService, IStateService } from '../../state/node/state.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService, UserDataProfilesService as BaseUserDataProfilesService, StoredUserDataProfile, StoredProfileAssociations } from '../common/userDataProfile.js';
import { isString } from '../../../base/common/types.js';
import { SaveStrategy, StateService } from '../../state/node/stateService.js';

type StoredUserDataProfileState = StoredUserDataProfile & { location: URI | string };

export class UserDataProfilesReadonlyService extends BaseUserDataProfilesService implements IUserDataProfilesService {

	constructor(
		@IStateReadService private readonly stateReadonlyService: IStateReadService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@INativeEnvironmentService protected readonly nativeEnvironmentService: INativeEnvironmentService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
	) {
		super(nativeEnvironmentService, fileService, uriIdentityService, logService);
	}

	protected override getStoredProfiles(): StoredUserDataProfile[] {
		const storedProfilesState = this.stateReadonlyService.getItem<UriDto<StoredUserDataProfileState>[]>(UserDataProfilesReadonlyService.PROFILES_KEY, []);
		return storedProfilesState.map(p => ({
			...p,
			location: isString(p.location) ? this.uriIdentityService.extUri.joinPath(this.profilesHome, p.location) : URI.revive(p.location),
		}));
	}

	protected override getStoredProfileAssociations(): StoredProfileAssociations {
		return this.stateReadonlyService.getItem<StoredProfileAssociations>(UserDataProfilesReadonlyService.PROFILE_ASSOCIATIONS_KEY, {});
	}

	protected override getDefaultProfileExtensionsLocation(): URI {
		return this.uriIdentityService.extUri.joinPath(URI.file(this.nativeEnvironmentService.extensionsPath).with({ scheme: this.profilesHome.scheme }), 'extensions.json');
	}

	protected override createDefaultProfile() {
		const profile = super.createDefaultProfile();
		const home = URI.joinPath(this.nativeEnvironmentService.userHome, '.steamharness');
		if (!this.uriIdentityService.extUri.isEqualOrParent(URI.file(this.nativeEnvironmentService.userDataPath), URI.joinPath(home, 'hosts'))) { return profile; }
		const shared = URI.joinPath(home, 'studio', 'User').with({ scheme: profile.location.scheme });
		// Only share user-editable preferences. SecretStorage, authentication, and window state remain host-local.
		return { ...profile, settingsResource: URI.joinPath(shared, 'settings.json'), keybindingsResource: URI.joinPath(shared, 'keybindings.json'),
			tasksResource: URI.joinPath(shared, 'tasks.json'), snippetsHome: URI.joinPath(shared, 'snippets'), promptsHome: URI.joinPath(shared, 'prompts') };
	}

}

export class UserDataProfilesService extends UserDataProfilesReadonlyService implements IUserDataProfilesService {

	constructor(
		@IStateService protected readonly stateService: IStateService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
	) {
		super(stateService, uriIdentityService, environmentService, fileService, logService);
	}

	protected override saveStoredProfiles(storedProfiles: StoredUserDataProfile[]): void {
		if (storedProfiles.length) {
			this.stateService.setItem(UserDataProfilesService.PROFILES_KEY, storedProfiles.map(profile => ({ ...profile, location: this.uriIdentityService.extUri.relativePath(this.profilesHome, profile.location) })));
		} else {
			this.stateService.removeItem(UserDataProfilesService.PROFILES_KEY);
		}
	}

	protected override saveStoredProfileAssociations(storedProfileAssociations: StoredProfileAssociations): void {
		if (storedProfileAssociations.emptyWindows || storedProfileAssociations.workspaces) {
			this.stateService.setItem(UserDataProfilesService.PROFILE_ASSOCIATIONS_KEY, storedProfileAssociations);
		} else {
			this.stateService.removeItem(UserDataProfilesService.PROFILE_ASSOCIATIONS_KEY);
		}
	}
}

export class ServerUserDataProfilesService extends UserDataProfilesService implements IUserDataProfilesService {

	constructor(
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
	) {
		super(new StateService(SaveStrategy.IMMEDIATE, environmentService, logService, fileService), uriIdentityService, environmentService, fileService, logService);
	}

	override async init(): Promise<void> {
		await (this.stateService as StateService).init();
		return super.init();
	}

}
