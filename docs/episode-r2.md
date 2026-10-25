# Staging R2 d'un épisode Bun Video

`scripts/episode-r2.ts` prépare et transfère le package complet vers le bucket et
le domaine **explicitement qualifiés** par Infra. Il réutilise
`loadCloudflareEnvironment` et `createR2Client` de Bun Cloudflare ; les credentials
restent dans le store protégé et le transport utilise `Bun.S3Client` natif.
Aucun token, cookie, header signé ou fichier d'authentification n'est journalisé.

Le bucket qualifié est `shenron-cdn`. Chaque objet est adressé par ses octets :
**`_objects/<object-sha256>`**, sans suffixe. Le namespace de routes proposé est
`media/episodes/875/<source-sha256>/` ; une frame propose `<image-sha256>.png`.
Ces routes restent des hints non publiés jusqu'à l'intervention du publisher.
Le transfert
comprend tous les volumes tar.gz, le manifeste public complet, les checksums,
la source MP4 et les petits assets référencés. Les frames directement
servies sont l'union de 240 références uniformes, des frames sélectionnées pour
les cues et des six références du handoff visuel, avec une borne de 600 PNG.
Les 33 511 frames intégrales restent dans les archives : aucun second upload
direct de toute la séquence n'est créé.

```powershell
bun scripts/episode-r2.ts plan '<dossier épisode>' --bucket '<bucket qualifié>' --origin 'https://<domaine qualifié>' --profile '<profil STS protégé>'
bun scripts/episode-r2.ts upload '<dossier épisode>' --file-timeout-ms 900000 --job-timeout-ms 5400000
bun scripts/episode-r2.ts stage-core '<dossier épisode>' --bucket shenron-cdn --origin https://cdn.dragonballfr.com --limit 1 --profile '<profil STS protégé>' --job-timeout-ms 5400000
```

Lancer le second travail en arrière-plan avec journaux bornés. Deux processus
maximum transfèrent chacun un fichier à la fois ; chaque transfert et le job
complet possèdent une deadline. Une erreur arrête les processus possédés et
conserve les reçus déjà écrits. Réexécuter `upload` contrôle d'abord les objets
existants et reprend les objets manquants. Un objet existant dont le contenu
diffère échoue sans écrasement.

Chaque fichier local est vérifié par SHA-256 avant envoi. La vérification distante
utilise `HEAD` taille + ETag MD5 pour un objet simple ; un ETag multipart ou autre
format déclenche un `GET` streamé avec comparaison SHA-256 et taille. L'uploader
n'accepte pas simplement l'existence d'une clé ou un statut HTTP 200 comme preuve
d'intégrité. `.r2/upload-receipt.json` conserve clés, tailles, hashes, ETags,
méthode de vérification, action et date ; le plan local contient les chemins
locaux nécessaires à l'exécution, mais n'est pas transféré.

Le manifeste public est une projection allowlist de `EpisodePackageManifest` :
les chemins d'assets et membres d'archives restent relatifs ; les propriétés
locales supplémentaires et données d'authentification sont exclues. L'inventaire
public ne contient que clés, hints de routes sur le domaine configuré, tailles,
types et hashes. Les fichiers d'exécution restent dans `.r2/`, exclu par
l'indexer d'assets ; aucun plan contenant un chemin absolu n'est envoyé.

`stage-core` transfère les volumes déjà finalisés pendant que le package continue
de se construire. Il exclut le dernier nom de volume, potentiellement encore
écrit ou vérifié. Les headers finaux et le manifeste attendent la fin du package.
Le transport REST est un fallback explicite via le SDK Cloudflare propriétaire :
[Upload Object](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/)
accepte au maximum 300 MB par requête. Le body `Bun.file` est transmis comme Blob
binaire, sans sérialisation JSON. Les vidéos plus grandes requièrent le transport
S3 qualifié ou le propriétaire distant ; leur contenu existe aussi dans les
volumes archivés. Le premier profil S3 ne permettait pas ce staging et a produit
HTTP 403 au probe HEAD. Le profil STS ensuite délivré par le propriétaire Infra
a qualifié HEAD et PUT sur le bucket exact et le préfixe `_objects/`.
`--profile` lit ce JSON uniquement en mémoire, vérifie scope et expiration,
et passe son `sessionToken` au client natif. Les valeurs ne sont ni copiées dans
l'environnement partagé, ni archivées, ni journalisées. Le renouvellement reste
au propriétaire du profil ; l'uploader ne crée aucun token.

Le mode natif utilise `new Response(Bun.file(...).stream())` avec des parts de
8 MiB et une queue interne bornée à deux parts. Un volume de 67 065 655 octets
a produit un ETag à huit parts et son GET streamé a confirmé le SHA-256 complet.
Deux processus maximum restent actifs ; la mémoire des parts est bornée.
Ce probe a pris environ 172 secondes : il qualifie le transport, sans promettre
une livraison de dizaines de gigaoctets dans le TTL d'un seul profil.

Le publisher exige aussi `customMetadata.sha256` et le MIME exact. Le reçu
conserve `customMetadataSha256:"verified"` seulement quand les métadonnées
distantes le confirment ; sinon `"pending-owner"` distingue la préservation
des octets de la préparation complète à publier. Aucun catalogue n'est activé
sur la seule base du flag d'intégrité du payload.

Le staging n'active aucun pointeur ou catalogue public. La publication Shenron
appartient uniquement au publisher DBFR sérialisé
`/etc/aphrody/cloudflare/cli/publish-catalog.ts`. La session Shenron reçoit le
handoff et les reçus pour cette étape distincte ; un upload R2 réussi ne constitue
pas une publication éditoriale ni une lecture publique qualifiée.

## Relais SSH lorsque le transfert R2 local est trop lent

Écrire `.r2/stop-requested` pour terminer les fichiers R2 déjà engagés puis
interrompre les prochains dequeue. Le handoff attend les reçus des fichiers
précédents par événements filesystem, sans boucle de sleep. `STATUS.json`
conserve `state`, `finishedAt`, `sourceSHA256`, `transport`, la deadline et
l'état de handoff. Pendant qu'un sender de reprise est réellement actif, il reste
`state:"running"`, `transport:"ssh"`, `finishedAt:null`,
`payloadComplete:false`, avec `disposition:"handoff-ssh"`.
Son contrat typé `EpisodeTransferStatus` porte
`schema:"bun-video/r2-transfer-status/v1"`, `sourceSHA` et l'alias
`sourceSHA256`. Les probes `core` et `direct` peuvent être terminés sans
terminer la livraison globale : ils gardent `disposition:"partial-stage"`.

`scripts/episode-ssh.ts` utilise directement `bun ssh exec --native --json`
et `bun ssh sftp --native`, avec le runtime qui exécute le script. Il ne lance
aucune CLI Aphrody. Le mode de comparaison `--scp` passe aussi par `bun ssh cp`.
Le contexte `dbfr` qualifié a renvoyé le hostname
`vps-6732365f`, utilisateur `ubuntu`, et environ 31,6 GB libres. Ces observations
du 13 octobre 2026 sont à revérifier avant chaque transfert. Le script vérifie
le hostname, l'espace et le chemin résolu avant SFTP.

```powershell
bun scripts/episode-ssh.ts '<dossier épisode>' package/assets-0001.tar.gz 300000
```

Le benchmark transfère un seul volume déjà hashé, puis compare son SHA-256
sur le serveur. La fenêtre du relais reste limitée à deux volumes, environ
128 MiB, dans `/home/ubuntu/.local/share/aphrody/media-staging/<sourceSHA>/`.
Ne pas y recopier tout le package de dizaines de gigaoctets. Ne démarrer ce
transfert qu'après fermeture des deux workers R2 locaux.

Le probe natif SFTP de 67 099 654 octets a pris 191,076 secondes, environ
0,35 MB/s ; son SHA-256 distant est identique. Ce résultat ne démontre donc
pas une amélioration du débit R2 local. Le mode `--scp` compare une autre voie
Windows native, OpenSSH avec 64 requêtes SFTP et des buffers de 256 KiB :

```powershell
bun scripts/episode-ssh.ts '<dossier épisode>' package/assets-0002.tar.gz 300000 --scp
```

Ce second probe a pris 244,716 secondes pour 67 065 655 octets, environ
0,274 MB/s ; son SHA-256 distant est aussi identique. Ces deux voies ne
qualifient pas une accélération du transfert depuis le poste Windows.

Conserver ces deux fichiers au maximum dans la fenêtre. Leur dépôt SSH seul
n'est pas une mise en production ; le récepteur propriétaire doit encore
qualifier la préservation R2 et la publication.

Le récepteur canonique ensuite installé a été qualifié avec `--help` et les
SHA-256 de ses sources primaires Shenron : `stage-file.ts`, `transfer.ts`,
`s3-profile.ts` et `cloudflare-ops.ts`. Son invocation passe par `sudo -n`, le
runtime propriétaire `/home/ubuntu/.local/share/aphrody/cloudflare-cli/runtime/bun`
et `/etc/aphrody/cloudflare/cli/stage-file.ts`. Le serveur utilise son propre
profil protégé ; aucun credential local ne passe par SSH. Le publisher reste
une étape distincte : ce récepteur n'écrit aucun pointeur ou registre public.

Le premier volume réellement absent, `assets-0009.tar.gz`, a été transféré
en 135,195 secondes, puis préservé en R2 par le récepteur en 6,166 secondes.
L'attestation a confirmé deux GET SHA-256, les métadonnées et le MIME ; son
input temporaire distant a été supprimé seulement après le reçu privé durable.
Les deux benchmarks antérieurs ont également été qualifiés sans renvoyer
leurs octets déjà présents en CAS.
Les mesures historiques précèdent le passage du sender à `bun ssh` direct ;
elles ne qualifient pas à elles seules le débit du nouveau job.

## Reprise persistante et reconstruction à la demande

```powershell
bun scripts/episode-ssh.ts stage '<dossier épisode>' '<checkout Shenron>' --dry-run
bun scripts/episode-ssh.ts stage '<dossier épisode>' '<checkout Shenron>' --limit 2 --job-timeout-ms 5400000
bun scripts/episode-ssh.ts stage '<dossier épisode>' '<checkout Shenron>' --job-timeout-ms 86400000
```

Le dry-run ne contacte pas le serveur et n'effectue aucun transfert. Le plan
privé conserve les références exactes du manifeste courant, son SHA-256, les
volumes manquants et la borne de deux fichiers/128 MiB. Chaque reprise relit
ce manifeste : les preuves ajoutées ultérieurement peuvent ainsi être livrées
sans figer une ancienne liste de volumes.
Le sender résout d'abord le dossier configuré avec `realpath` : un alias de
workspace peut pointer vers le store d'acquisition propriétaire. Il transmet
ce chemin physique au helper, sans affaiblir son rejet des symlinks internes.
Les chemins privés et les acquisitions `catalogue/` étrangères sont refusés
avant tout transfert. Le sender utilise le garde de chemins du propriétaire
`src/episode-assets.ts` ; il ne distribue pas tout le store d'acquisition.

Pour une archive absente, le sender appelle exclusivement
`rehydrateEpisodeVolume` du propriétaire `src/episode-assets.ts`. Une seule
régénération s'exécute à la fois. Les blobs et slices de grands fichiers
sont vérifiés contre le manifeste ; l'ordre des entrées, gzip niveau 1 et
mtime 0 reconstituent le format initial. L'archive complète doit retrouver
exactement SHA-256 et taille avant toute publication locale ou envoi.
Un asset source manquant ou modifié est refusé ; la source MP4 ne suffit pas
à retrouver les octets d'un ancien MKV FFmpeg. Retirer un dérivé irrécupérable
du manifeste appartient à son propriétaire, pas au sender.

Deux transports au maximum partagent la fenêtre distante. Les fichiers
`.part` sont créés en mode 600, hashés puis renommés dans cette même fenêtre.
Le SFTP est borné à 600 secondes et le récepteur à 300 secondes. Les reçus
canoniques déjà présents évitent reconstruction et retransfert ; le job
s'arrête sur une erreur du helper ou de son authentification.

Les archives locales recréées portent un ledger `createdBy` privé. Après
qualification canonique seulement, le sender recontrôle chemin résolu,
inode, taille, mtime et SHA-256, puis supprime ce seul fichier recréé. Une
archive originale sans ledger reste préservée ; sources, frames et metadata
ne correspondent jamais au filtre de suppression.

`.r2/ssh-core-receipt.json` et `STATUS.json` sont écrits atomiquement, avec
progrès, deadline et ETA fondée sur le débit effectivement observé. La fin
d'un job borné conserve un état partiel qui peut être repris ; la fin des
archives seules ne met pas `payloadComplete` à vrai et n'affirme pas une
publication. Des dizaines de gigaoctets à ces débits peuvent demander plus
d'une journée : l'ETA n'est pas une preuve de livraison.

Lorsqu'un sender SSH quitte, `STATUS.json` porte `state:"failed"`, une date
`finishedAt` réelle et `activeFiles:0`, en conservant les compteurs qualifiés.
Une erreur de préqualification est également terminale. Un job limité ou
arrêté avant le payload complet porte `partial-stage-job-exited` ; la fin des
seules archives porte `core-only-job-exited`. La livraison reprend depuis les
reçus, sans annoncer un processus actif après sa sortie.

Tests locaux : `bun test test/episode-r2.test.ts` vérifie le namespace,
l'allowlist, les domaines autorisés et l'union bornée des frames. Les requêtes
R2 et la lecture publique doivent ensuite être qualifiées sur le bucket choisi.
