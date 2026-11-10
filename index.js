'use strict';
/**
 * homebridge-hkcontrol : ré-expose dans Maison (via Homebridge) les accessoires
 * HomeKit appairés dans le plugin Jeedom hkControl.
 */
const {HkControlPlatform, PLUGIN_NAME, PLATFORM_NAME} = require('./lib/platform');

module.exports = (api) => {
	api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HkControlPlatform);
};
