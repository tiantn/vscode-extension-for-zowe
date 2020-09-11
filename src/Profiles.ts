/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

import { IProfileLoaded, Logger, CliProfileManager, IProfile, IUpdateProfile, Session } from "@zowe/imperative";
import * as path from "path";
import { URL } from "url";
import * as vscode from "vscode";
import * as globals from "./globals";
import { ZoweExplorerApiRegister } from "./api/ZoweExplorerApiRegister";
import { errorHandling, getZoweDir, FilterDescriptor, FilterItem, resolveQuickPickHelper } from "./utils";
import { IZoweTree } from "./api/IZoweTree";
import { DefaultProfileManager } from "./profiles/DefaultProfileManager";
import { IZoweNodeType, IZoweUSSTreeNode, IZoweDatasetTreeNode, IZoweJobTreeNode, IZoweTreeNode } from "./api/IZoweTreeNode";
import * as nls from "vscode-nls";

// Set up localization
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

interface IProfileValidation {
    status: string;
    name: string;
    session: Session;
}

interface IValidationSetting {
    name: string;
    setting: boolean;
}

export enum ValidProfileEnum {
    UNVERIFIED = 1,
    VALID = 0,
    INVALID = -1
}
export class Profiles {
    // Processing stops if there are no profiles detected
    public static async createInstance(log: Logger): Promise<Profiles> {
        Profiles.loader = new Profiles(log);
        await Profiles.loader.refresh();
        return Profiles.loader;
    }

    public static getInstance(): Profiles { return Profiles.loader; }

    private static loader: Profiles;

    public profilesForValidation: IProfileValidation[] = [];
    public profilesValidationSetting: IValidationSetting[] = [];
    public allProfiles: IProfileLoaded[] = [];
    public loadedProfile: IProfileLoaded;
    public validProfile: ValidProfileEnum = ValidProfileEnum.INVALID;
    private dsSchema: string = "Zowe-DS-Persistent";
    private ussSchema: string = "Zowe-USS-Persistent";
    private jobsSchema: string = "Zowe-Jobs-Persistent";
    private allTypes: string[];
    private profilesByType = new Map<string, IProfileLoaded[]>();
    private profileManagerByType = new Map<string, CliProfileManager>();
    private constructor(private log: Logger) { }

    /**
     * Check to see if the current profile is valid, invalid, or unverified (not allowed to be validated)
     *
     * @export
     * @param {boolean} prompt - should the user be prompted for any details missing from the profile?
     */
    public async checkCurrentProfile(profileLoaded: IProfileLoaded, prompt?: boolean): Promise<any> {
        try {
            const profileStatus: IProfileValidation = await this.getProfileSetting(profileLoaded, prompt);
            if (profileStatus.status === "unverified") {
                this.validProfile = ValidProfileEnum.UNVERIFIED;
                return profileStatus;
            }

            if (!profileStatus.session) {
                // Credentials are invalid
                this.validProfile = ValidProfileEnum.INVALID;
                return profileStatus;
            } else {
                // Credentials are valid
                this.validProfile = ValidProfileEnum.VALID;
                return profileStatus;
            }
        } catch (error) {
            errorHandling(error, profileLoaded.name,
                localize("checkCurrentProfile.error", "Error encountered in {0}", `checkCurrentProfile.optionalProfiles!`));
            return { status: "inactive", name: profileLoaded.name, session: null };
        }
    }

    /**
     * Gets the verification setting for a profile...should it be verified or no?
     * If the profile SHOULD be validated, this function will also call validateProfile to do the validation
     *
     * @export
     * @param {boolean} prompt - should the user be prompted for any details missing from the profile?
     */
    public async getProfileSetting(theProfile: IProfileLoaded, prompt?: boolean): Promise<IProfileValidation> {
        let profileStatus: IProfileValidation;
        let found: boolean = false;
        this.profilesValidationSetting.filter(async (instance) => {
            if ((instance.name === theProfile.name) && (instance.setting === false)) {
                // Don't allow validation if the user doesn't want it
                profileStatus = {
                    status: "unverified",
                    name: instance.name,
                    session: undefined
                };
                if (this.profilesForValidation.length > 0) {
                    // Check to see if the profile has been validated before
                    this.profilesForValidation.filter((profile) => {
                        if ((profile.name === theProfile.name) && (profile.status === "unverified")) {
                            found = true;
                        }
                        if ((profile.name === theProfile.name) && (profile.status !== "unverified")) {
                            found = true;
                            const index = this.profilesForValidation.lastIndexOf(profile);
                            this.profilesForValidation.splice(index, 1, profileStatus);
                        }
                    });
                }
                if (!found) {
                    this.profilesForValidation.push(profileStatus);
                }
            }
        });
        if (profileStatus === undefined) {
            // If the profile has not been validated, and is allowed to be validated, call validateProfiles
            profileStatus = await this.validateProfiles(theProfile, prompt);
        }
        return profileStatus;
    }

    /**
     * Handles the validation of a profile by calling getStatus
     *
     * @export
     * @param {boolean} prompt - should the user be prompted for any details missing from the profile?
     */
    public async validateProfiles(theProfile: IProfileLoaded, prompt?: boolean) {
        let filteredProfile: IProfileValidation;
        let profileStatus;
        const getSessStatus = await ZoweExplorerApiRegister.getInstance().getCommonApi(theProfile);

        // Filter profilesForValidation to check if the profile is already validated as active
        this.profilesForValidation.filter((profile) => {
            if ((profile.name === theProfile.name) && (profile.status === "active")){
                filteredProfile = {
                    status: profile.status,
                    name: profile.name,
                    session: profile.session
                };
            }
        });

        // If not yet validated or inactive, call getStatus and validate the profile
        // status will be stored in profilesForValidation
        if (filteredProfile === undefined) {
            try {
                if (getSessStatus.getStatus) {
                    profileStatus = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: localize("Profiles.validateProfiles.validationProgress", "Validating {0} Profile.", theProfile.name),
                        cancellable: true
                    }, async (progress, token) => {
                        token.onCancellationRequested(() => {
                            // will be returned as undefined
                            vscode.window.showInformationMessage(
                                localize("Profiles.validateProfiles.validationCancelled", "Validating {0} was cancelled.", theProfile.name));
                        });
                        return getSessStatus.getStatus(theProfile, theProfile.type, prompt);
                    });
                } else {
                    profileStatus = "unverified";
                }

                filteredProfile = {
                    status: profileStatus.status,
                    name: theProfile.name,
                    session: profileStatus.session
                };
                this.profilesForValidation.push(filteredProfile);
            } catch (error) {
                this.log.debug("Validate Error - Invalid Profile: " + error);
                filteredProfile = {
                    status: "inactive",
                    name: theProfile.name,
                    session: undefined
                };
                this.profilesForValidation.push(filteredProfile);
            }
        }
        return filteredProfile;
    }

    public async disableValidation(node: IZoweNodeType): Promise<IZoweNodeType> {
        this.disableValidationContext(node);
        return node;
    }

    public async disableValidationContext(node: IZoweNodeType) {
        const theProfile: IProfileLoaded = node.getProfile();
        this.validationArraySetup(theProfile, false);
        if (node.contextValue.includes(`${globals.VALIDATE_SUFFIX}true`)) {
            node.contextValue = node.contextValue.replace(/(_validate=true)/g, "").replace(/(_Active)/g, "").replace(/(_Inactive)/g, "");
            node.contextValue = node.contextValue + `${globals.VALIDATE_SUFFIX}false`;
        } else if (node.contextValue.includes(`${globals.VALIDATE_SUFFIX}false`)) {
            return node;
        } else {
            node.contextValue = node.contextValue + `${globals.VALIDATE_SUFFIX}false`;
        }
        return node;
    }

    public async enableValidation(node: IZoweNodeType): Promise<IZoweNodeType> {
        this.enableValidationContext(node);
        return node;
    }

    public async enableValidationContext(node: IZoweNodeType) {
        const theProfile: IProfileLoaded = node.getProfile();
        this.validationArraySetup(theProfile, true);
        if (node.contextValue.includes(`${globals.VALIDATE_SUFFIX}false`)) {
            node.contextValue = node.contextValue.replace(/(_validate=false)/g, "").replace(/(_Unverified)/g, "");
            node.contextValue = node.contextValue + `${globals.VALIDATE_SUFFIX}true`;
        } else if (node.contextValue.includes(`${globals.VALIDATE_SUFFIX}true`)) {
            return node;
        } else {
            node.contextValue = node.contextValue + `${globals.VALIDATE_SUFFIX}true`;
        }

        return node;
    }

    public async validationArraySetup(theProfile: IProfileLoaded, validationSetting: boolean): Promise<IValidationSetting> {
        let found: boolean = false;
        let profileSetting: IValidationSetting;
        if (this.profilesValidationSetting.length > 0) {
            this.profilesValidationSetting.filter((instance) => {
                if ((instance.name === theProfile.name) && (instance.setting === validationSetting)) {
                    found = true;
                    profileSetting = {
                        name: instance.name,
                        setting: instance.setting
                    };
                }
                if ((instance.name === theProfile.name) && (instance.setting !== validationSetting)) {
                    found = true;
                    profileSetting = {
                        name: instance.name,
                        setting: validationSetting
                    };
                    const index = this.profilesValidationSetting.lastIndexOf(instance);
                    this.profilesValidationSetting.splice(index, 1, profileSetting);
                }
            });
            if (!found) {
                profileSetting = {
                    name: theProfile.name,
                    setting: validationSetting
                };
                this.profilesValidationSetting.push(profileSetting);
            }
        } else {
            profileSetting = {
                name: theProfile.name,
                setting: validationSetting
            };
            this.profilesValidationSetting.push(profileSetting);
        }
        return profileSetting;
    }

    public loadNamedProfile(name: string, type?: string): IProfileLoaded {
        for (const profile of this.allProfiles) {
            if (profile.name === name && (type ? profile.type === type : true)) { return profile; }
        }
        throw new Error(localize("loadNamedProfile.error.profileName", "Could not find profile named: {0}.", name));
    }

    public getProfiles(type: string = "zosmf"): IProfileLoaded[] { return this.profilesByType.get(type); }

    public async refresh(): Promise<void> {
        this.allProfiles = [];
        this.allTypes = [];

        // Set the default base profile (base is not a type included in registeredApiTypes)
        let profileManager = await this.getCliProfileManager("base");
        if (profileManager) {
            try {
                DefaultProfileManager.getInstance().setDefaultProfile("base", (await profileManager.load({ loadDefault: true })));
            } catch (err) {
                vscode.window.showErrorMessage(localize("profiles.refresh", "Error: {0}", err.message));
            }
        }

        // Handle all API profiles
        for (const type of ZoweExplorerApiRegister.getInstance().registeredApiTypes()) {
            profileManager = await this.getCliProfileManager(type);
            const profilesForType = await profileManager.loadAll({ typeOnly: true });
            if (profilesForType && profilesForType.length > 0) {
                this.allProfiles.push(...profilesForType);
                this.profilesByType.set(type, profilesForType);
                let defaultProfile: IProfileLoaded;

                try { defaultProfile = await profileManager.load({ loadDefault: true }); }
                catch (error) { vscode.window.showInformationMessage(error.message); }

                DefaultProfileManager.getInstance().setDefaultProfile(type, defaultProfile);
            }
            // This is in the loop because I need an instantiated profile manager config
            if (profileManager.configurations && this.allTypes.length === 0) {
                for (const element of profileManager.configurations) { this.allTypes.push(element.type); }
            }
        }
        while (this.profilesForValidation.length > 0) {
            this.profilesForValidation.pop();
        }
    }

    /**
     * Adds a new Profile to the provided treeview by clicking the 'Plus' button and
     * selecting which profile you would like to add from the drop-down that appears.
     * The profiles that are in the tree view already will not appear in the
     * drop-down.
     *
     * @export
     * @param {USSTree} zoweFileProvider - either the USS, MVS, JES tree
     */
    public async createZoweSession(zoweFileProvider: IZoweTree<IZoweTreeNode>) {
        const allProfiles = (await Profiles.getInstance()).allProfiles;
        const createNewProfile = "Create a New Connection to z/OS";
        let chosenProfile: string = "";

        // Get all profiles
        let profileNamesList = allProfiles.map((profile) => {
            return profile.name;
        });
        // Filter to list of the APIs available for current tree explorer
        profileNamesList = profileNamesList.filter((profileName) => {
            const profile = Profiles.getInstance().loadNamedProfile(profileName);
            if (zoweFileProvider.getTreeType() === globals.PersistenceSchemaEnum.USS) {
                const ussProfileTypes = ZoweExplorerApiRegister.getInstance().registeredUssApiTypes();
                return ussProfileTypes.includes(profile.type);
            }
            if (zoweFileProvider.getTreeType() === globals.PersistenceSchemaEnum.Dataset) {
                const mvsProfileTypes = ZoweExplorerApiRegister.getInstance().registeredMvsApiTypes();
                return mvsProfileTypes.includes(profile.type);
            }
            if (zoweFileProvider.getTreeType() === globals.PersistenceSchemaEnum.Job) {
                const jesProfileTypes = ZoweExplorerApiRegister.getInstance().registeredJesApiTypes();
                return jesProfileTypes.includes(profile.type);
            }
        });
        if (profileNamesList) {
            profileNamesList = profileNamesList.filter((profileName) =>
                // Find all cases where a profile is not already displayed
                !zoweFileProvider.mSessionNodes.find((sessionNode) => sessionNode.getProfileName() === profileName)
            );
        }
        const createPick = new FilterDescriptor("\uFF0B " + createNewProfile);
        const items: vscode.QuickPickItem[] = profileNamesList.map((element) => new FilterItem(element));
        const quickpick = vscode.window.createQuickPick();
        const placeholder = localize("addSession.quickPickOption",
            "Choose \"Create new...\" to define a new profile or select an existing profile to Add to the USS Explorer");

        if (globals.ISTHEIA) {
            const options: vscode.QuickPickOptions = {
                placeHolder: placeholder
            };
            // get user selection
            const choice = (await vscode.window.showQuickPick([createPick, ...items], options));
            if (!choice) {
                vscode.window.showInformationMessage(localize("enterPattern.pattern", "No selection made."));
                return;
            }
            chosenProfile = choice === createPick ? "" : choice.label;
        } else {
            quickpick.items = [createPick, ...items];
            quickpick.placeholder = placeholder;
            quickpick.ignoreFocusOut = true;
            quickpick.show();
            const choice = await resolveQuickPickHelper(quickpick);
            quickpick.hide();
            if (!choice) {
                vscode.window.showInformationMessage(localize("enterPattern.pattern", "No selection made."));
                return;
            }
            if (choice instanceof FilterDescriptor) {
                chosenProfile = "";
            } else {
                chosenProfile = choice.label;
            }
        }

        if (chosenProfile === "") {
            let newprofile: any;
            let profileName: string;
            if (quickpick.value) { profileName = quickpick.value; }

            const options = {
                placeHolder: localize("createZoweSession.option.prompt.profileName.placeholder", "Connection Name"),
                prompt: localize("createZoweSession.option.prompt.profileName", "Enter a name for the connection"),
                value: profileName
            };
            profileName = await vscode.window.showInputBox(options);
            if (!profileName) {
                vscode.window.showInformationMessage(localize("createZoweSession.enterprofileName",
                    "Profile Name was not supplied. Operation Cancelled"));
                return;
            }
            chosenProfile = profileName.trim();
            globals.LOG.debug(localize("addSession.log.debug.createNewProfile", "User created a new profile"));
            const defaultProfile = DefaultProfileManager.getInstance().getDefaultProfile("zosmf");

            try { newprofile = await Profiles.getInstance().createNewConnection(defaultProfile, chosenProfile); }
            catch (error) { await errorHandling(error, chosenProfile, error.message); }
            if (newprofile) {
                try { await Profiles.getInstance().refresh(); }
                catch (error) {
                    await errorHandling(error, newprofile, error.message);
                }
                await zoweFileProvider.addSession(newprofile);
                await zoweFileProvider.refresh();
            }
        } else if (chosenProfile) {
            globals.LOG.debug(localize("createZoweSession.log.debug.selectProfile", "User selected profile ") + chosenProfile);
            await zoweFileProvider.addSession(chosenProfile);
        } else {
            globals.LOG.debug(localize("createZoweSession.log.debug.cancelledSelection", "User cancelled profile selection"));
        }
    }

    public async editSession(profileLoaded: IProfileLoaded, profileName: string): Promise<IProfile | void> {
        const schema = await this.getSchema("zosmf");
        const updSchemaValues = await Profiles.getInstance().collectProfileDetails(null,
                profileLoaded.profile,
                schema);
        updSchemaValues.name = profileName;
        Object.keys(updSchemaValues).forEach((key) => {
            profileLoaded.profile[key] = updSchemaValues[key];
        });

        const newProfile = await this.updateProfile({ profile: profileLoaded.profile, name: profileName, type: profileLoaded.type });
        vscode.window.showInformationMessage(localize("editConnection.success", "Profile was successfully updated"));
        return newProfile;
    }

    public async getProfileType(): Promise<string> {
        let profileType: string;
        const profTypes = ZoweExplorerApiRegister.getInstance().registeredApiTypes();
        const typeOptions = Array.from(profTypes);
        if (typeOptions.length === 1 && typeOptions[0] === "zosmf") { profileType = typeOptions[0]; }
        else {
            const quickPickTypeOptions: vscode.QuickPickOptions = {
                placeHolder: localize("getProfileType.option.prompt.type.placeholder", "Profile Type"),
                ignoreFocusOut: true,
                canPickMany: false
            };
            profileType = await vscode.window.showQuickPick(typeOptions, quickPickTypeOptions);
        }
        return profileType;
    }

    public async getSchema(profileType: string): Promise<{}> {
        const profileManager = await this.getCliProfileManager(profileType);
        const configOptions = Array.from(profileManager.configurations);
        let schema: {};
        for (const val of configOptions) {
            if (val.type === profileType) {
                schema = val.schema.properties;
            }
        }
        return schema;
    }

    public async collectProfileDetails(detailsToGet?: string[], oldDetails?: any, schema?: any): Promise<any> {
        let newUrl: any;
        let newPort: number;
        let newUser: string;
        let newPass: string;
        let newRU: boolean;
        const schemaValues: any = {};

        const profileType = "zosmf";
        if (!profileType) {
            throw new Error(localize("collectProfileDetails.profileTypeMissing",
                "No profile type was chosen. Operation Cancelled"));
        }
        if (!detailsToGet) { detailsToGet = Object.keys(schema); }
        schemaValues.type = profileType;

        // Go through array of schema for input values
        for (const profileDetail of detailsToGet) {
            switch (profileDetail) {
                case "host":
                    const hostOptions: vscode.InputBoxOptions = {
                        ignoreFocusOut: true,
                        value: oldDetails && oldDetails[profileDetail] ? oldDetails[profileDetail] : null,
                        placeHolder: localize("collectProfileDetails.option.prompt.url.placeholder", "Optional: url:port"),
                        prompt: localize("collectProfileDetails.option.prompt.url", "Enter a z/OS URL in the format 'url:port'."),
                        validateInput: (value) => {
                            const validationResult = {
                                valid: false,
                                protocol: null,
                                host: null,
                                port: null
                            };

                            // Check that the URL is valid
                            try {
                                newUrl = value.replace(/https:\/\//g, "");
                                newUrl = new URL("https://" + value);
                            } catch (error) {
                                return localize("collectProfileDetails.invalidzosURL",
                                    "Please enter a valid host URL in the format 'url:port'.");
                            }

                            if (value === "https://") {
                                // User did not enter a host/port
                                validationResult.host = "";
                                validationResult.port = 0;
                                validationResult.valid = true;
                                newUrl = validationResult;
                            } else {
                                // User would like to store host/port
                                validationResult.port = Number(newUrl.port);
                                validationResult.host = newUrl.hostname;
                                validationResult.valid = true;
                                newUrl = validationResult;
                            }

                            return null;
                        }
                    };

                    newUrl = await vscode.window.showInputBox(hostOptions);
                    if (!newUrl) {
                        throw new Error(localize("collectProfileDetails.zosmfURL", "No valid value for z/OS URL. Operation Cancelled"));
                    } else {
                        newUrl = newUrl.replace(/https:\/\//g, "");
                        newUrl = new URL("https://" + newUrl);
                        newUrl.host = newUrl.host.replace(/'/g, "");
                        schemaValues[profileDetail] = newUrl.port ? newUrl.host.substring(0, newUrl.host.indexOf(":")) : newUrl.host;
                        if (newUrl.port !== 0) { schemaValues.port = Number(newUrl.port); }
                    }
                    break;
                case "port":
                    if (schemaValues[profileDetail] === 0) {
                        let portOptions: vscode.InputBoxOptions = {
                            ignoreFocusOut: true,
                            value: oldDetails && oldDetails[profileDetail] ? oldDetails[profileDetail] : null,
                            validateInput: (value) => {
                                if (Number.isNaN(Number(value))) {
                                    return localize("collectProfileDetails.invalidPort", "Please enter a valid port number");
                                } else { return null; }
                            }
                        };

                        // Use as default value the port number from the profile type's default schema
                        // (default is defined for each profile type in ...node_modules\@zowe\cli\lib\imperative.js)
                        if (schema[profileDetail].optionDefinition.hasOwnProperty("defaultValue")) {
                            // Default value defined in schema
                            portOptions = {
                                prompt: schema[profileDetail].optionDefinition.description.toString(),
                                value: oldDetails && oldDetails[profileDetail] ?
                                    oldDetails[profileDetail] : schema[profileDetail].optionDefinition.defaultValue.toString()
                            };
                        } else {
                            // No default value defined
                            portOptions = {
                                placeHolder: localize("collectProfileDetails.option.prompt.port.placeholder", "Port Number"),
                                prompt: schema[profileDetail].optionDefinition.description.toString(),
                            };
                        }

                        let port;
                        const portFromUser = await vscode.window.showInputBox(portOptions);
                        if (Number.isNaN(Number(portFromUser))) {
                            throw new Error(localize("collectProfileDetails.undefined.port",
                                "Invalid Port number provided or operation was cancelled"));
                        } else { port = Number(portFromUser); }

                        // Use default from schema if user entered 0 as port number
                        if (port === 0 && schema[profileDetail].optionDefinition.hasOwnProperty("defaultValue")) {
                            port = Number(schema[profileDetail].optionDefinition.defaultValue.toString());
                        } else if (schemaValues.host === "") { port = 0; }

                        schemaValues[profileDetail] = newPort = port;
                        break;
                    }
                    break;
                case "user":
                    const userOptions = {
                        placeHolder: localize("collectProfileDetails.option.prompt.username.placeholder", "Optional: User Name"),
                        prompt: localize("collectProfileDetails.option.prompt.username", "Enter the user name for the connection."),
                        ignoreFocusOut: true,
                        value: oldDetails && oldDetails[profileDetail] ? oldDetails[profileDetail] : null,
                        validateInput: async (value) => {
                            if (value === undefined || value.trim() === undefined) {
                                return localize("collectProfileDetails.invalidUser", "Please enter a valid username");
                            } else { return null; }
                        }
                    };

                    newUser = await vscode.window.showInputBox(userOptions);
                    if (!newUser) {
                        if (newUser === undefined) {
                            throw new Error(localize("collectProfileDetails.undefined.user",
                                "Invalid user provided or operation was cancelled"));
                        }
                        vscode.window.showInformationMessage(localize("collectProfileDetails.undefined.username", "No username defined."));
                        newUser = null;
                    }
                    schemaValues[profileDetail] = newUser;
                    break;
                case "password":
                    const passOptions = {
                        placeHolder: localize("collectProfileDetails.option.prompt.password.placeholder", "Optional: Password"),
                        prompt: localize("collectProfileDetails.option.prompt.password", "Enter the password for the connection."),
                        password: true,
                        ignoreFocusOut: true,
                        value: oldDetails && oldDetails[profileDetail] ? oldDetails[profileDetail] : null,
                        validateInput: (value) => {
                            if (value === undefined || value.trim() === undefined) {
                                return localize("collectProfileDetails.invalidUser", "Please enter a valid password");
                            } else { return null; }
                        }
                    };

                    newPass = await vscode.window.showInputBox(passOptions);
                    if (!newPass) {
                        if (newPass === undefined) {
                            throw new Error(localize("collectProfileDetails.undefined.pass",
                                "Invalid password provided or operation was cancelled"));
                        }
                        vscode.window.showInformationMessage(localize("collectProfileDetails.undefined.password", "No password defined."));
                        newPass = null;
                    }
                    schemaValues[profileDetail] = newPass;
                    break;
                case "rejectUnauthorized":
                    const quickPickOptions: vscode.QuickPickOptions = {
                        placeHolder: localize("collectProfileDetails.option.prompt.ru.placeholder", "Reject Unauthorized Connections"),
                        ignoreFocusOut: true,
                        canPickMany: false
                    };
                    const ruOptions = ["True - Reject connections with self-signed certificates",
                        "False - Accept connections with self-signed certificates"];

                    const chosenRU = await vscode.window.showQuickPick(ruOptions, quickPickOptions);

                    if (chosenRU === ruOptions[0]) { newRU = true; }
                    else if (chosenRU === ruOptions[1]) { newRU = false; }
                    else {
                        throw new Error(localize("collectProfileDetails.rejectUnauthorize", "No certificate option selected. Operation Cancelled"));
                    }

                    schemaValues[profileDetail] = newRU;
                    break;
                default:
                    let defaultOptions: vscode.InputBoxOptions;
                    let responseDescription: string;

                    const isTrue = Array.isArray(schema[profileDetail].type);
                    let index: number;
                    let schemaType;
                    if (isTrue) {
                        if (schema[profileDetail].type.includes("boolean")) {
                            index = schema[profileDetail].type.indexOf("boolean");
                            schemaType = schema[profileDetail].type[index];
                        }
                        if (schema[profileDetail].type.includes("number")) {
                            index = schema[profileDetail].type.indexOf("number");
                            schemaType = schema[profileDetail].type[index];
                        }
                        if (schema[profileDetail].type.includes("string")) {
                            index = schema[profileDetail].type.indexOf("string");
                            schemaType = schema[profileDetail].type[index];
                        }
                    } else { schemaType = schema[profileDetail].type; }

                    switch (schemaType) {
                        case "number":
                            let numberOptions: vscode.InputBoxOptions;
                            responseDescription = schema[profileDetail].optionDefinition.description.toString();

                            // Use the default value from the schema in the prompt
                            // (defaults are defined in ...node_modules\@zowe\cli\lib\imperative.js)
                            if (schema[profileDetail].optionDefinition.hasOwnProperty("defaultValue")) {
                                // A default value is defined
                                numberOptions = {
                                    prompt: responseDescription,
                                    value: schema[profileDetail].optionDefinition.defaultValue
                                };
                            } else {
                                // No default value is defined
                                numberOptions = {
                                    placeHolder: responseDescription,
                                    prompt: responseDescription
                                };
                            }

                            const userInput = await vscode.window.showInputBox(numberOptions);

                            // Validate numerical input
                            if (!Number.isNaN(Number(userInput))) { schemaValues[profileDetail] = Number(userInput); }
                            else {
                                // Input is invalid, either use default value form schema or leave undefined
                                if (schema[profileDetail].optionDefinition.hasOwnProperty("defaultValue")) {
                                    schemaValues[profileDetail] = schema[profileDetail].optionDefinition.defaultValue;
                                } else { schemaValues[profileDetail] = undefined; }
                            }
                            break;
                        case "boolean":
                            let boolVal: boolean;
                            const selectBoolean = ["True", "False"];
                            const booleanOptions: vscode.QuickPickOptions = {
                                placeHolder: schema[profileDetail].optionDefinition.description.toString(),
                                ignoreFocusOut: true,
                                canPickMany: false
                            };

                            const chosenValue = await vscode.window.showQuickPick(selectBoolean, booleanOptions);

                            if (chosenValue === selectBoolean[0]) { boolVal = true; }
                            else if (chosenValue === selectBoolean[1]) { boolVal = false; }
                            else { boolVal = undefined; }

                            if (boolVal === undefined) {
                                throw new Error(localize("collectProfileDetails.booleanValue", "No boolean selected. Operation Cancelled"));
                            } else {
                                schemaValues[profileDetail] = boolVal;
                                break;
                            }
                        default:
                            responseDescription = schema[profileDetail].optionDefinition.description.toString();

                            // Use the default value from the schema in the prompt
                            // (defaults are defined in ...node_modules\@zowe\cli\lib\imperative.js)
                            if (schema[profileDetail].optionDefinition.hasOwnProperty("defaultValue")) {
                                // A default value is defined
                                defaultOptions = {
                                    prompt: responseDescription,
                                    value: schema[profileDetail].optionDefinition.defaultValue
                                };
                            } else {
                                // No default value is defined
                                defaultOptions = {
                                    placeHolder: responseDescription,
                                    prompt: responseDescription,
                                    value: oldDetails && oldDetails[profileDetail] ? oldDetails[profileDetail] : null,
                                };
                            }

                            const defValue = await vscode.window.showInputBox(defaultOptions);

                            if (defValue === "") { schemaValues[profileDetail] = null; }
                            else {
                                schemaValues[profileDetail] = defValue;
                                break;
                            }
                    }
            }
        }

        return schemaValues;
    }

    public async createNewConnection(profileLoaded: IProfileLoaded, profileName: string, requestedProfileType?: string): Promise<string | undefined> {
        const newProfileName = profileName.trim();
        if (newProfileName === undefined || newProfileName === "") {
            vscode.window.showInformationMessage(localize("createNewConnection.profileName",
                "Profile name was not supplied. Operation Cancelled"));
            return undefined;
        }

        const profileType = requestedProfileType ? requestedProfileType : await this.getProfileType();
        if (profileType === undefined) {
            vscode.window.showInformationMessage(localize("createNewConnection.profileType",
                "No profile type was chosen. Operation Cancelled"));
            return undefined;
        }

        try {
            const newProfileDetails = await Profiles.getInstance().collectProfileDetails(null,
                    profileLoaded.profile,
                    await this.getSchema(profileType));
            newProfileDetails.name = newProfileName;
            newProfileDetails.type = profileType;
            if (!newProfileDetails.user) { delete newProfileDetails.user; }
            if (!newProfileDetails.password) { delete newProfileDetails.password; }
            if (!newProfileDetails.basePath) { delete newProfileDetails.basePath; }

            for (const profile of this.allProfiles) {
                if (profile.name.toLowerCase() === profileName.toLowerCase()) {
                    vscode.window.showErrorMessage(localize("createNewConnection.duplicateProfileName",
                        "Profile name already exists. Please create a profile using a different name"));
                    return undefined;
                }
            }
            await this.saveProfile(newProfileDetails, newProfileDetails.name, newProfileDetails.type);
            vscode.window.showInformationMessage("Profile " + newProfileDetails.name + " was created.");
            return newProfileDetails.name;
        } catch (error) {
            await errorHandling(error);
        }
    }

    public async getDeleteProfile() {
        const allProfiles: IProfileLoaded[] = this.allProfiles;
        const profileNamesList = allProfiles.map((temprofile) => {
            return temprofile.name;
        });

        if (!profileNamesList.length) {
            vscode.window.showInformationMessage(localize("deleteProfile.noProfilesLoaded", "No profiles available"));
            return;
        }

        const quickPickList: vscode.QuickPickOptions = {
            placeHolder: localize("deleteProfile.quickPickOption", "Select the profile you want to delete"),
            ignoreFocusOut: true,
            canPickMany: false
        };
        const sesName = await vscode.window.showQuickPick(profileNamesList, quickPickList);

        if (sesName === undefined) {
            vscode.window.showInformationMessage(localize("deleteProfile.undefined.profilename",
                "Operation Cancelled"));
            return;
        }

        return allProfiles.find((temprofile) => temprofile.name === sesName);
    }

    public async deleteProfile(datasetTree: IZoweTree<IZoweDatasetTreeNode>, ussTree: IZoweTree<IZoweUSSTreeNode>,
                               jobsProvider: IZoweTree<IZoweJobTreeNode>, node?: IZoweNodeType) {

        let deleteLabel: string;
        let deletedProfile: IProfileLoaded;
        if (!node) { deletedProfile = await this.getDeleteProfile(); }
        else { deletedProfile = node.getProfile(); }

        if (!deletedProfile) { return; }
        deleteLabel = deletedProfile.name;

        const deleteSuccess = await this.deletePrompt(deletedProfile);
        if (!deleteSuccess) {
            vscode.window.showInformationMessage(localize("deleteProfile.noSelected",
                "Operation Cancelled"));
            return;
        }

        // Delete from data det file history
        const fileHistory: string[] = datasetTree.getFileHistory();
        fileHistory.slice().reverse()
            .filter((ds) => ds.substring(1, ds.indexOf("]")).trim() === deleteLabel.toUpperCase())
            .forEach((ds) => {
                datasetTree.removeFileHistory(ds);
            });

        // Delete from Data Set Favorites
        datasetTree.mFavorites.forEach((favNode) => {
            const findNode = favNode.label.trim();
            // const findNode = favNode.label.substring(1, favNode.label.indexOf("]")).trim();

            if (findNode === deleteLabel) {
                // datasetTree.removeFavorite(favNode);
                datasetTree.mFavorites = datasetTree.mFavorites.filter((tempNode) => tempNode.label.trim() !== findNode);
                favNode.dirty = true;
                datasetTree.refresh();
            }
        });

        // Delete from Data Set Tree
        datasetTree.mSessionNodes.forEach((sessNode) => {
            if (sessNode.getProfileName() === deleteLabel) {
                datasetTree.hideSession(sessNode);
                sessNode.dirty = true;
                datasetTree.refresh();
            }
        });

        // Delete from USS file history
        const fileHistoryUSS: string[] = ussTree.getFileHistory();
        fileHistoryUSS.slice().reverse()
            .filter((uss) => uss.substring(1, uss.indexOf("]")).trim() === deleteLabel.toUpperCase())
            .forEach((uss) => {
                ussTree.removeFileHistory(uss);
            });

        // Delete from USS Favorites
        ussTree.mFavorites.forEach((ses) => {
            const findNode = ses.label.trim();
            if (findNode === deleteLabel) {
                ussTree.mFavorites = ussTree.mFavorites.filter((tempNode) => tempNode.label.trim() !== findNode);
                ses.dirty = true;
                ussTree.refresh();
            }
        });

        // Delete from USS Tree
        ussTree.mSessionNodes.forEach((sessNode) => {
            if (sessNode.getProfileName() === deleteLabel) {
                ussTree.hideSession(sessNode);
                sessNode.dirty = true;
                ussTree.refresh();
            }
        });

        // Delete from Jobs Favorites
        jobsProvider.mFavorites.forEach((ses) => {
            const findNode = ses.label.substring(1, ses.label.indexOf("]")).trim();
            if (findNode === deleteLabel) {
                jobsProvider.removeFavorite(ses);
                ses.dirty = true;
                jobsProvider.refresh();
            }
        });

        // Delete from Jobs Tree
        jobsProvider.mSessionNodes.forEach((jobNode) => {
            if (jobNode.getProfileName() === deleteLabel) {
                jobsProvider.hideSession(jobNode);
                jobNode.dirty = true;
                jobsProvider.refresh();
            }
        });

        // Delete from Data Set Sessions list
        const dsSetting: any = { ...vscode.workspace.getConfiguration().get(this.dsSchema) };
        let sessDS: string[] = dsSetting.sessions;
        let faveDS: string[] = dsSetting.favorites;
        sessDS = sessDS.filter((element) => {
            return element.trim() !== deleteLabel;
        });
        faveDS = faveDS.filter((element) => {
            return element.substring(1, element.indexOf("]")).trim() !== deleteLabel;
        });
        dsSetting.sessions = sessDS;
        dsSetting.favorites = faveDS;
        await vscode.workspace.getConfiguration().update(this.dsSchema, dsSetting, vscode.ConfigurationTarget.Global);

        // Delete from USS Sessions list
        const ussSetting: any = { ...vscode.workspace.getConfiguration().get(this.ussSchema) };
        let sessUSS: string[] = ussSetting.sessions;
        let faveUSS: string[] = ussSetting.favorites;
        sessUSS = sessUSS.filter((element) => {
            return element.trim() !== deleteLabel;
        });
        faveUSS = faveUSS.filter((element) => {
            return element.substring(1, element.indexOf("]")).trim() !== deleteLabel;
        });
        ussSetting.sessions = sessUSS;
        ussSetting.favorites = faveUSS;
        await vscode.workspace.getConfiguration().update(this.ussSchema, ussSetting, vscode.ConfigurationTarget.Global);

        // Delete from Jobs Sessions list
        const jobsSetting: any = { ...vscode.workspace.getConfiguration().get(this.jobsSchema) };
        let sessJobs: string[] = jobsSetting.sessions;
        let faveJobs: string[] = jobsSetting.favorites;
        sessJobs = sessJobs.filter((element) => {
            return element.trim() !== deleteLabel;
        });
        faveJobs = faveJobs.filter((element) => {
            return element.substring(1, element.indexOf("]")).trim() !== deleteLabel;
        });
        jobsSetting.sessions = sessJobs;
        jobsSetting.favorites = faveJobs;
        await vscode.workspace.getConfiguration().update(this.jobsSchema, jobsSetting, vscode.ConfigurationTarget.Global);

        // Remove from list of all profiles
        const index = this.allProfiles.findIndex((deleteItem) => {
            return deleteItem === deletedProfile;
        });
        if (index >= 0) { this.allProfiles.splice(index, 1); }
    }

    public getAllTypes() { return this.allTypes; }

    public async getNamesForType(type: string) {
        const profileManager = await this.getCliProfileManager(type);
        const profilesForType = await profileManager.loadAll({ typeOnly: true });
        return profilesForType.map((profile) => {
            return profile.name;
        });
    }

    public async directLoad(type: string, name: string): Promise<IProfileLoaded> {
        let directProfile: IProfileLoaded;
        const profileManager = await this.getCliProfileManager(type);
        if (profileManager) { directProfile = await profileManager.load({ name }); }

        return directProfile;
    }

    public async getCliProfileManager(type: string): Promise<CliProfileManager> {
        let profileManager = this.profileManagerByType.get(type);
        if (!profileManager) {
            try {
                profileManager = await new CliProfileManager({
                    profileRootDirectory: path.join(getZoweDir(), "profiles"),
                    type
                });
                if (profileManager) { this.profileManagerByType.set(type, profileManager); }
                else { return undefined; }
            } catch (err) {
                return null;
            }
        }
        return profileManager;
    }

    private async deletePrompt(deletedProfile: IProfileLoaded) {
        const profileName = deletedProfile.name;
        this.log.debug(localize("deleteProfile.log.debug", "Deleting profile ") + profileName);
        const quickPickOptions: vscode.QuickPickOptions = {
            placeHolder: localize("deleteProfile.quickPickOption", "Delete {0}? This will permanently remove it from your system.", profileName),
            ignoreFocusOut: true,
            canPickMany: false
        };
        // confirm that the user really wants to delete
        if (await vscode.window.showQuickPick([localize("deleteProfile.showQuickPick.delete", "Delete"),
        localize("deleteProfile.showQuickPick.cancel", "Cancel")], quickPickOptions) !==
            localize("deleteProfile.showQuickPick.delete", "Delete")) {
            this.log.debug(localize("deleteProfile.showQuickPick.log.debug", "User picked Cancel. Cancelling delete of profile"));
            return;
        }

        try {
            this.deleteProfileOnDisk(deletedProfile);
        } catch (error) {
            this.log.error(localize("deleteProfile.delete.log.error", "Error encountered when deleting profile! ") + JSON.stringify(error));
            await errorHandling(error, profileName, error.message);
            throw error;
        }

        vscode.window.showInformationMessage("Profile " + profileName + " was deleted.");
        return profileName;
    }

    private async deleteProfileOnDisk(ProfileInfo) {
        let zosmfProfile: IProfile;
        try {
            zosmfProfile = await (await this.getCliProfileManager(ProfileInfo.type))
                .delete({ profile: ProfileInfo, name: ProfileInfo.name, type: ProfileInfo.type });
        } catch (error) { vscode.window.showErrorMessage(error.message); }

        return zosmfProfile.profile;
    }

    // ** Functions that Calls Get CLI Profile Manager  */

    private async updateProfile(ProfileInfo, rePrompt?: boolean): Promise<IProfile | void> {
        if (ProfileInfo.type !== undefined) {
            const profileManager = await this.getCliProfileManager(ProfileInfo.type);
            this.loadedProfile = (await profileManager.load({ name: ProfileInfo.name }));
        } else {
            for (const type of ZoweExplorerApiRegister.getInstance().registeredApiTypes()) {
                const profileManager = await this.getCliProfileManager(type);
                this.loadedProfile = (await profileManager.load({ name: ProfileInfo.name }));
            }
        }

        const OrigProfileInfo = this.loadedProfile.profile;
        const NewProfileInfo = ProfileInfo.profile;

        const profileArray = Object.keys(NewProfileInfo);
        for (const value of profileArray) {
            OrigProfileInfo[value] = NewProfileInfo[value];
            if (NewProfileInfo[value] == null) { delete OrigProfileInfo[value]; }
        }

        const updateParms: IUpdateProfile = {
            name: this.loadedProfile.name,
            merge: false,
            profile: OrigProfileInfo as IProfile
        };
        try {
            const updatedProfile = await (await this.getCliProfileManager(this.loadedProfile.type)).update(updateParms);
            return updatedProfile.profile;
        } catch (error) {
            // When no password is entered, we should silence the error message for not providing it
            // since password is optional in Zowe Explorer
            if (!error.message.includes("Must have user & password OR base64 encoded credentials")) {
                errorHandling(error);
            }
        }
    }

    private async saveProfile(ProfileInfo, ProfileName, ProfileType) {
        let newProfile: IProfile;
        try {
            newProfile = await (await this.getCliProfileManager(ProfileType)).save({ profile: ProfileInfo, name: ProfileName, type: ProfileType });
        } catch (error) {
            vscode.window.showErrorMessage(error.message);
        }
        return newProfile.profile;
    }
}
