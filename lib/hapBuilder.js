'use strict';
/**
 * Traduction de la description HAP native (JSON /accessories d'un accessoire HomeKit)
 * vers des services/caractéristiques HAP-NodeJS génériques, à l'identique.
 */

const HAP_UUID_SUFFIX = '-0000-1000-8000-0026BB765291';

const expandUUID = (type) => {
	const t = String(type);
	return ((t.length <= 8) ? t.padStart(8, '0') + HAP_UUID_SUFFIX : t).toUpperCase();
};

const UUID = {
	ACCESSORY_INFORMATION: expandUUID('3E'),
	PROTOCOL_INFORMATION: expandUUID('A2'),
	IDENTIFY: expandUUID('14'),
	NAME: expandUUID('23'),
	MANUFACTURER: expandUUID('20'),
	MODEL: expandUUID('21'),
	SERIAL_NUMBER: expandUUID('30'),
	FIRMWARE_REVISION: expandUUID('52'),
	HARDWARE_REVISION: expandUUID('53'),
};

// Services non relayables (flux caméra/audio, DataStream, transports, appairage...) : exclus du MVP
const EXCLUDED_SERVICES = new Set([
	'A2', // Protocol Information (fourni par Homebridge)
	'55', // Pairing
	'110', // Camera RTP Stream Management
	'204', // Camera Recording Management (HKSV)
	'21A', // Camera Operating Mode
	'129', // Data Stream Transport Management
	'127', // Audio Stream Management
	'133', // Siri
	'122', // Target Control Management
	'203', // Transfer Transport Management
	'22A', // Wi-Fi Transport
	'701', // Thread Transport
].map(expandUUID));

const KNOWN_PERMS = new Set(['pr', 'pw', 'ev', 'aa', 'tw', 'hd', 'wr']);

/**
 * Accessoire à ignorer : aid 1 d'un pont (seulement information + protocole).
 */
function isBridgeInfoOnly(hapAcc) {
	const useful = (hapAcc.services || []).filter((s) => {
		const u = expandUUID(s.type);
		return u !== UUID.ACCESSORY_INFORMATION && !EXCLUDED_SERVICES.has(u);
	});
	return useful.length === 0;
}

function skipServiceReason(svc) {
	const u = expandUUID(svc.type);
	if (EXCLUDED_SERVICES.has(u)) {
		return 'service non relayable';
	}
	return null;
}

/**
 * Caractéristiques non relayables : écriture-réponse (wr, points de contrôle TLV8)
 * et formats binaires en écriture (Adaptive Lighting, etc.).
 */
function skipCharReason(c) {
	const perms = Array.isArray(c.perms) ? c.perms : [];
	if (perms.includes('wr')) {
		return 'écriture-réponse (wr) non supportée';
	}
	if ((c.format === 'tlv8' || c.format === 'data') && perms.includes('pw')) {
		return 'écriture TLV8/data non supportée';
	}
	if (!perms.includes('pr') && !perms.includes('pw') && !perms.includes('ev')) {
		return 'aucune permission utile';
	}
	return null;
}

/**
 * Props HAP-NodeJS à partir des métadonnées HAP.
 */
function charProps(c) {
	const props = {
		format: c.format,
		perms: (c.perms || []).filter((p) => KNOWN_PERMS.has(p)),
	};
	const copy = {
		unit: 'unit',
		minValue: 'minValue',
		maxValue: 'maxValue',
		minStep: 'minStep',
		maxLen: 'maxLen',
		maxDataLen: 'maxDataLen',
		'valid-values': 'validValues',
		'valid-values-range': 'validValueRanges',
		description: 'description',
	};
	for (const [from, to] of Object.entries(copy)) {
		if (c[from] !== undefined && c[from] !== null) {
			props[to] = c[from];
		}
	}
	return props;
}

function findChar(svc, uuid) {
	return (svc.characteristics || []).find((c) => expandUUID(c.type) === uuid);
}

function charValue(svc, uuid) {
	const c = findChar(svc, uuid);
	return (c && c.value !== undefined && c.value !== null) ? String(c.value) : null;
}

function infoService(hapAcc) {
	return (hapAcc.services || []).find((s) => expandUUID(s.type) === UUID.ACCESSORY_INFORMATION) || null;
}

/**
 * Nom de l'accessoire : caractéristique Name du service d'information, sinon repli.
 */
function accessoryName(hapAcc, fallback) {
	const info = infoService(hapAcc);
	return (info && charValue(info, UUID.NAME)) || fallback || 'hkControl';
}

function serviceName(svc) {
	return charValue(svc, UUID.NAME) || svc.serviceOriginalName || svc.typeLabel || '';
}

function charName(c) {
	return c.description || c.typeLabel || expandUUID(c.type);
}

/**
 * Nom accepté par HomeKit : lettres/chiffres au début et à la fin, caractères simples.
 */
function sanitizeName(name) {
	const cleaned = String(name || '')
		.replace(/[^\p{L}\p{N}\s'’.,-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
		.trim();
	return cleaned || 'hkControl';
}

module.exports = {
	expandUUID,
	UUID,
	isBridgeInfoOnly,
	skipServiceReason,
	skipCharReason,
	charProps,
	accessoryName,
	serviceName,
	charName,
	charValue,
	infoService,
	sanitizeName,
};
