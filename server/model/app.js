"use strict";

const {id, key, remove, shasum} = require('../util');

const version = require('semver');

const {alreadyExists, alreadyExistsMsg, notFound, missingParameter, notAuthorized, invalidRequest} = require('./errors');

const excludeNull = obj=> Object.keys(obj).reduce((ret, key)=> {
    if (obj[key] == null) return ret;
    ret[key] = obj[key];
    return ret;
}, {});

const fixver = (ver)=>ver ? ('' + ver).replace(/^(\d+?)$/, '$1.0.0') : '0.0.0';

const Perms = {
    Owner: ['Owner'],
    Collaborator: ['Collaborator'],
    Any: ['Owner', 'Collaborator']
};


const hasDeploymentName = ({deployments}, deployment) => {
    if (!deployments)return false;
    if (Array.isArray(deployments)) {
        return deployments.indexOf(deployment) > -1;
    }
    return deployment in deployments;
};

const hasPerm = (app, email, perms = Perms.Any)=> {
    missingParameter(app, 'app');
    missingParameter(email, 'email');
    const c = app.collaborators[email];
    return c && perms.indexOf(c.permission) > -1;
};

const _newDeployment = name=> {
    return {
        "createdTime": Date.now(),
        name,
        "key": key(),
        "id": id(),
        "package": null
    }
};
const _addDeployment = (app, name)=> {
    if (!app.deployments) {
        app.deployments = {};
    }
    return (app.deployments[name] = _newDeployment(name));
};

const notAuthorizedPerm = (app, email, perm, message)=> {
    if (hasPerm(app, email, Perms[perm] || perm)) {
        return app;
    }
    return notAuthorized(false, message);
};


module.exports = (dao, weighted, upload) => {
    const api = {};
    return Object.assign(api, {
        findApp({email, app}){
            return dao.appForCollaborator(email, app).then(result => notFound(result, `App not found ${app}`));
        },
        _findApp(find, perm = 'Owner', errorMessage = `Do not have permission to do this operation.`){
            return api.findApp(find).then(app =>notAuthorizedPerm(app, find.email, perm, errorMessage));
        },
        createApp({email, name, deployments = ["Production", "Staging"]}) {
            if (!name) {
                return new Promise((r, reject)=> missingParameter(name, 'name'));
            }
            return dao.appForCollaborator(email, name).then(check=> {
                alreadyExists(!check, name);

                const app = ({
                    name,
                    "collaborators": {
                        [email]: {
                            "permission": "Owner"
                        }
                    }
                });

                deployments.forEach((name) => _addDeployment(app, name));
                return dao.createApp(app);
            });
        },

        removeApp(find) {
            return api._findApp(find, 'Owner', 'Must be owner of app to remove')
                .then(app=> dao.removeApp(app.id).then(v=>app));
        },

        renameApp(find){
            return api._findApp(find, 'Owner', 'Must be owner of app to rename').then(app=> {
                app.name = find.name;
                return dao.updateApp(app.id, app).then(v=>app);
            });
        },

        transferApp(find)
        {
            return api._findApp(find, 'Owner', 'Must be owner of app to transfer').then(app=>dao.userByEmail(find.transfer).then(u=> {
                notFound(u, `The specified e-mail address doesn't represent a registered user`);
                const owner = app.collaborators[find.email];
                const transfer = app.collaborators[find.transfer] || (app.collaborators[find.transfer] = {});
                owner.permission = 'Collaborator';
                transfer.permission = 'Owner';
                return dao.updateApp(app.id, app);
            }));
        },

        listApps({email}){
            return dao.appsForCollaborator(email);
        },

        listDeployments(find){
            return api.findApp(find).then(app=>dao.deploymentsByApp(app.id, app.deployments)
                .then(deployments=>app.deployments.map(name=>deployments[name])));
        },
        getDeployment(find){
            return api.findApp(find).then(app=>dao.deploymentByApp(app.id, find.deployment));
        },
        removeDeployment(params){
            return api.findApp(params).then(app=> dao.removeDeployment(app.id, params.deployment));
        },

        renameDeployment(params){
            return api.findApp(params).then(app=> {
                const {deployment, name} = params;
                notFound(hasDeploymentName(app, deployment), `Deployment '${deployment}' not found ${params.app}`);
                alreadyExists(!hasDeploymentName(app, name), name, 'deployment');
                return dao.renameDeployment(app.id, deployment, name);
            });
        },

        promoteDeployment(params)
        {
            return api.findApp(params).then(app=> {

                return dao.deploymentsByApp(app.id, [params.deployment, params.to]).then(deployments=> {
                    const f = deployments[params.deployment];

                    notFound(f && f.package, `Deployment "${params.deployment}" does not exist.`);

                    const t = notFound(deployments[params.to], `Deployment "${params.to}" does not exist.`);

                    const pkg = f.package;

                    const {
                        isDisabled = pkg.isDisabled, isMandatory = pkg.isMandatory, rollout = pkg.rollout, appVersion = pkg.appVersion, description = pkg.description
                    } = params;

                    return dao.addPackage(t.key, {
                        packageHash: pkg.packageHash,
                        isDisabled,
                        isMandatory,
                        rollout,
                        appVersion,
                        uploadTime: Date.now(),
                        description,
                        releasedBy: params.email,
                        releaseMethod: "Promote",
                        originalLabel: pkg.label,
                        originalDeployment: params.deployment
                    });
                })
            });
        },

        historyDeployment(params)
        {
            return api.findApp(params).then(app=>dao.history(app.id, params.deployment));
        },


        updateDeployment(params)
        {
            return api.findApp(params).then(app=>dao.deploymentByApp(app.id, params.deployment).then(deployment=> {
                notFound(deployment, `Deployment not found '${params.deployment}'`);
                notFound(deployment.package, `Deployment has no releases.`);

                const pkg = deployment.package;
                const {
                    isDisabled = pkg.isDisabled,
                    isMandatory = pkg.isMandatory,
                    rollout = pkg.rollout,
                    appVersion = pkg.appVersion,
                    description = pkg.description
                } =  excludeNull(params);

                invalidRequest(!(params.rollout != null && (pkg.rollout != null && params.rollout < pkg.rollout)), `Can not set rollout below existing rollout ${pkg.rollout}`);

                const npkg = {
                    isDisabled,
                    isMandatory,
                    rollout,
                    appVersion,
                    description
                };

                return dao.updatePackage(deployment.key, npkg);
            }));
        },

        addDeployment({email, app, name})
        {
            return api._findApp({
                email,
                app
            }, 'Any', `Do not have permission to  add deployment to '${app}'.`).then(app=> {

                alreadyExists(!hasDeploymentName(app, name), name, `deployment`);
                return dao.addDeployment(app.id, name, _newDeployment(name));
            });
        },

        removeCollaborator({email, app, collaborator})
        {
            return api._findApp({email, app}, 'Owner', `Must be owner to remove a collaborator`).then(app=> {

                notAuthorized(app.collaborators[collaborator].permission !== 'Owner',
                    `Cannot remove the owner of the app from collaborator list.`);
                notFound((email in app.collaborators),
                    `The given account is not a collaborator for this app.`);

                delete app.collaborators[collaborator];
                return dao.updateApp(app.id, app);
            });
        },


        addCollaborator({email, app, collaborator})
        {
            return api._findApp({email, app}, 'Owner', `Must be owner to add collaborator`).then(app=> {
                alreadyExistsMsg(!(collaborator in app.collaborators), `The given account is already a collaborator for this app.`);


                return dao.userByEmail(collaborator).then(a=> {

                    notFound(a, `The specified e-mail address doesn't represent a registered user`);

                    app.collaborators[collaborator] = {
                        "permission": "Collaborator"
                    };
                    return dao.updateApp(app.id, app).then(v=>true);
                });
            });
        },


        /**
         * {
	"package": {
		"description": "",
		"isDisabled": false,
		"isMandatory": false,
		"rollout": 100,
		"appVersion": "1",
		"packageHash": "3c6ebf5bae90813ba7db2a475d2a73ced0535f60e69b47f3bf81dd00361653d1",
		"blobUrl": "https://codepush.blob.core.windows.net/storagev2/GS7OibP4VaS001t2O0GWsMXC0bQp4yecGHaB-",
		"size": 6126,
		"releaseMethod": "Upload",
		"uploadTime": 1468962405823,
		"label": "v1",
		"releasedBy": "speajus@gmail.com"
	}
}
         * param app
         * param email
         * param deployment
         * param package
         * param packageInfo
         */

        upload(vals){
            const {
                app,
                email,
                deployment = 'Staging',
                downloadUrl = '',
                packageInfo: {
                    description = '',
                    isDisabled = false, label, isMandatory = false, rollout = 100, appVersion = '1.0.0'
                }
            } = vals;
            return api.findApp({email, app}).then(_app=> {

                notFound(hasDeploymentName(_app, deployment), `Not a valid deployment '${deployment}' for app '${app}'`);

                return dao.deploymentByApp(_app.id, deployment).then(deployments=> {
                    //noinspection JSUnresolvedVariable
                    const pkg = {
                        description, isDisabled, isMandatory, rollout, appVersion,
                        releaseMethod: "Upload",
                        uploadTime: Date.now(),
                        label: label || "v" + (deployments.history_ ? deployments.history_.length + 1 : 1),
                        releasedBy: email
                    };
                    return upload(vals.package).then(resp=> dao.addPackage(deployments.key, Object.assign({}, pkg, resp)));
                });
            })
        },
        download(hash){
            return dao.download(hash);
        },

        /**
         *  https://codepush.azurewebsites.net/updateCheck?deploymentKey=5UfjnOxv1FnCJ_DwPqMWQYSVlp0H4yecGHaB-&appVersion=1.2.3&packageHash=b10064ba007b3857655726404972980f963879fa4fe196b1ef9d06ae6d3891d5&isCompanion=&label=&clientUniqueId=4B4CBBF7-7F0A-4D34-BD9A-984FD190766D
         * param deploymentKey
         * param appVersion
         * param packageHash
         * param isCompanion
         * param label
         * param clientUniqueId
         */
        updateCheck(params)
        {

            missingParameter(params.deploymentKey, `Deployment key missing`);
            missingParameter(params.appVersion, `appVersion missing`);

            return dao.deploymentForKey(params.deploymentKey).then(deployment=> {
                const pkg = deployment && deployment.package;
                if (!pkg) {
                    /**
                     * If no packages have been published just return this.
                     */
                    return {
                        isAvailable: false,
                        shouldRunBinaryVersion: false
                    }
                }
                let isNotAvailable = pkg.packageHash == params.packageHash || !('clientUniqueId' in params);

                const appVersion = fixver(pkg.appVersion);

                function makeReturn(isAvailable) {
                    const packageSize = pkg && pkg.size && (pkg.size - 0) || 0;
                    return {
                        downloadURL: pkg.blobUrl,
                        isAvailable,
                        isMandatory: pkg.isMandatory,
                        appVersion,
                        label: pkg.label,
                        packageSize,
                        packageHash: pkg.packageHash,
                        description: pkg.description,
                        "updateAppVersion": version.lt(fixver(params.appVersion), appVersion),
                        //TODO - find out what this should be
                        "shouldRunBinaryVersion": false
                    }
                }

                return isNotAvailable ? makeReturn(isNotAvailable) : api.isUpdateAble(params.clientUniqueId, pkg.packageHash, pkg.rollout).then(makeReturn);

            });
        },
        clearHistory(params){
            return api._findApp(params, 'Owner', `Must be owner to clear history`).then(app => dao.clearHistory(app.id, params.deployment));
        },

        downloadReportStatus(/*{
                              clientUniqueId,
                              deploymentKey,
                              label
                              }*/ metric)
        {
            metric.status = 'Downloaded';
            return dao.insertMetric(metric);
        }
        ,
        /**
         * {
	"appVersion": "1.0.0",
	"deploymentKey": "5UfjnOxv1FnCJ_DwPqMWQYSVlp0H4yecGHaB-",
	"clientUniqueId": "fe231438a4f62c70",
	"label": "v1",
	"status": "DeploymentSucceeded",
	"previousLabelOrAppVersion": "1.0.0",
	"previousDeploymentKey": "5UfjnOxv1FnCJ_DwPqMWQYSVlp0H4yecGHaB-"
}
         respoonse 204
         */
        deployReportStatus(/*{
                            appVersion,
                            deploymentKey,
                            clientUniqueId,
                            label,
                            status,
                            previousLabelOrAppVersion,
                            previousDeploymentKey
                            }*/ metric){
            return dao.insertMetric(metric);
        },

        metrics(params)
        {
            return api.findApp(params).then(app=> {

                notFound(hasDeploymentName(app, params.deployment), params.deployment, 'deployment');
                return dao.deploymentByApp(app.id, params.deployment).then((deployment)=>dao.metrics(deployment.key).then((metrics = [])=> {

                    const {label} =deployment.package || {};
                    //    "DeploymentSucceeded" |  "DeploymentFailed" |  "Downloaded";
                    return metrics.reduce((obj, val)=> {
                        const key = val.label || val.appversion;
                        const ret = obj[key] || (obj[key] = {
                                active: 0,
                                downloaded: 0,
                                installed: 0,
                                failed: 0
                            });
                        switch (val.status) {
                            case 'DeploymentSucceeded':
                                ret.active++;
                                if (label === val.label) {
                                    //pervious deployment is no longer active.
                                    /*                                    obj[val.previouslabelorappversion] || (obj[val.previouslabelorappversion] = {
                                     active: 0,
                                     downloaded: 0,
                                     installed: 0,
                                     failed: 0
                                     });*/
                                    if (obj[val.previouslabelorappversion])
                                        obj[val.previouslabelorappversion].active--;
                                }
                                ret.installed++;
                                break;
                            case 'DeploymentFailed':
                                ret.failed++;
                                break;
                            case 'Downloaded':
                                ret.downloaded++;
                                break;

                        }
                        return obj;
                    }, {});
                }));
            });
        },

        rollback(params)
        {
            return api.findApp(params).then(app=> {
                if (params.label) {
                    return dao.historyLabel(app.id, params.deployment, params.label).then(rollto=>dao.deploymentByApp(app.id, params.deployment).then(deployment => ({
                        rollto,
                        deployment
                    })));
                } else {
                    return dao.deploymentByApp(app.id, params.deployment)
                        .then(deployment=>deployment.history_ && dao.packageById(deployment.history_[1]).then(rollto => ({
                            deployment,
                            rollto
                        })));
                }
            }).then(({rollto, deployment})=> {
                notFound(rollto, `Cannot perform rollback because there are no releases on this deployment.`);
                const {history_}= deployment;
                const dpkg = deployment.package;
                const pkg = Object.assign({}, rollto, {
                    uploadTime: Date.now(),
                    rollout: 100,
                    releasedBy: params.email,
                    releaseMethod: "Rollback",
                    originalLabel: dpkg.label,
                    label: `v${history_.length + 1}`
                });
                return dao.addPackage(deployment.key, pkg).then(v=>pkg);
            });

        },
        /**
         * So this keeps track of what the client got last time.
         * Any time a ratio or a packageHash changes we roll the dice,
         * as to weather they will be updated.  If the ratio has not
         * changed nor the packageHash or the uniqueClientId then return
         * the last roll of the die.
         * Otherwise roll the die and save the results so if we get asked again...
         *
         * @param uniqueClientId
         * @param packageHash
         * @param ratio
         * @returns {*}
         */
        isUpdateAble(uniqueClientId, packageHash, ratio){
            //ratio 0 means no deployment.
            if (ratio == 0) {
                return Promise.resolve(false);
            }
            //ratio null well shouldn't be so we'll do true.
            if (ratio == 100 || ratio == null) {
                return Promise.resolve(true);
            }

            return dao.clientRatio(uniqueClientId, packageHash).then(resp=> {
                //if the ratio is the same just return the last decision;
                if (resp && resp.ratio == ratio) {
                    return resp.updated;
                }
                const updated = weighted(ratio);
                return dao.insertClientRatio(uniqueClientId, packageHash, ratio, updated).then(_=>updated);
            });
        }
    });

};

