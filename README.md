# homebridge-hkcontrol

Plugin Homebridge (privé, installé depuis GitHub) qui ré-expose dans l'app Maison les accessoires HomeKit appairés dans le plugin Jeedom **hkControl**.

Un accessoire HomeKit n'accepte qu'un seul contrôleur : une fois appairé dans hkControl, il disparaît de Maison. Ce plugin le recrée **à l'identique** (mêmes services, caractéristiques, plages et permissions) à partir de sa description HAP native, et relaie lectures, écritures et événements via le démon hkControl. Il n'y a ni types génériques, ni virtuels, ni scénarios.

## Fonctionnement

```
Maison ⇄ Homebridge (child bridge) ⇄ homebridge-hkcontrol ⇄ démon hkControl (API /api/v1) ⇄ accessoire
```

- Une instance de plateforme `HkControl` par équipement hkControl exposé, chacune dans son propre child bridge.
- Le port du démon change à chaque démarrage : le plugin le demande à Jeedom (JSON-RPC `getExternalApi`, clé API du plugin hkControl).
- Les événements arrivent en direct par un flux SSE du démon. Si le démon ou l'accessoire est injoignable, Maison affiche « Pas de réponse ».
- Les écritures renvoient le vrai statut HAP de l'accessoire, et les écritures temporisées (serrures, portails) sont gérées.

## Configuration

La configuration est générée par le plugin Jeedom **homebridge** quand on coche « Exposer via Homebridge » sur un équipement hkControl. Pour référence :

```json
{
  "platform": "HkControl",
  "name": "hkControl Serrure entrée",
  "hkId": "1A:2B:3C:4D:5E:6F",
  "jeedomUrl": "http://192.168.1.10",
  "apikey": "<clé API du plugin hkControl>",
  "_bridge": {"name": "hkControl Serrure entrée", "username": "0E:AA:BB:CC:DD:01", "port": 51831, "pin": "031-45-156", "setupID": "HKC1"}
}
```

| Clé | Rôle |
|---|---|
| `hkId` | identifiant HomeKit de l'appareil dans hkControl (clé de `pairings.json`) |
| `jeedomUrl`, `apikey` | pour trouver le démon via Jeedom |
| `daemonUrl` | (tests) URL directe de l'API, ex. `http://127.0.0.1:55666/api/v1`, à la place de `jeedomUrl`/`apikey` |

Pas d'entrée `HkControl` dans la config = le plugin est installé mais ne fait rien.

## Logs

Le plugin écrit dans le log Jeedom **`hkControl_homebridge`**, au niveau de log du plugin hkControl. Ce niveau est transmis par `getExternalApi`, relu à chaque reconnexion et toutes les 2 minutes : pas besoin de relancer Homebridge quand on le change. Chaque ligne commence par le nom du pont, par exemple `[hkControl Prise salon]`.

| Niveau | Contenu |
|---|---|
| info | uniquement les états qui changent (`Prise > On : 1`, `… (depuis Maison)`), et le retour de l'équipement après une coupure |
| debug | en plus : actions venues de Maison et leur résultat, création (services, caractéristiques, éléments ignorés), connexions au démon, relectures de valeurs |
| warning / error | problèmes (démon ou équipement injoignable, écriture refusée…), toujours écrits |

Les warnings, les erreurs et les grandes étapes (démarrage, ajout ou retrait d'accessoire) restent aussi dans le log Homebridge (`homebridge_daemon`).

## Limites actuelles

Les services et caractéristiques suivants ne sont pas relayés (journalisés en debug) :
- caméras et flux (RTP, HKSV), Siri, DataStream, transports ;
- caractéristiques à écriture-réponse (`wr`) et écritures TLV8/data (dont Adaptive Lighting) ;
- service Protocol Information (fourni par Homebridge).

## Prérequis

- Node.js ≥ 22, Homebridge 2.x
- plugin Jeedom hkControl avec l'API v1 du démon (`/api/v1`) et `getExternalApi`

## Développement

```
npm test        # tests unitaires (node --test)
npm run lint
```
