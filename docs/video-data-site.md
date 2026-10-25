# Atelier Bun Video local

`bun src/apps/video-data-site-cli.ts` démarre le frontend React et ses APIs sur `127.0.0.1`, avec HTML/CSS/TSX compilés par Bun. Le processus partage le `VideoCatalog` et le pipeline canonique ; Remotion/HyperFrames restent des workers asynchrones.

APIs : `GET /api/overview`, `POST /api/query` structuré, `POST /api/import` multipart avec champ `capture`, `POST /api/export`, `GET /api/exports/<uuid>` et `POST /api/jobs` avec tableau ou `{jobs}`. Les téléchargements sont uniquement les datasets nettoyés enregistrés par le serveur. Leurs IDs sont persistés dans SQLite pour survivre au redémarrage.

`POST /api/publish` génère le catalogue distribuable et les quatre exports, les publie via le propriétaire Bun Cloudflare sur `aphrody-dist/bun-video`, puis vérifie leur SHA-256 depuis R2 et `dist.aphrody.app`. Cette action conserve les cookies, la configuration chiffrée et les HAR dans leurs magasins privés.

Les écritures exigent l'Origin exact de l'atelier local et toutes les APIs vérifient le Host. Aucun endpoint ne sert les cookies, HAR bruts, corps privés, chemins locaux ou messages d'erreur internes. Les imports sont limités à 256 MiB et restent dans le store privé de captures ; leur extraction documente DRM/plages sans les contourner.

Redis est activé uniquement par `BUN_VIDEO_REDIS_URL` explicite et son état exige un PING réel. Les jobs répondent immédiatement avec leurs IDs ; leur état se consulte via la vue structurée `jobs`. Les paramètres de rendu et exécutables sont fournis dans le plan de tâches, conformément au contrat des workers.

`--vault-env` déchiffre la configuration `bun-video.env` directement en mémoire. Le lanceur accepte uniquement les variables Bun Video, les chemins du bridge Python et `BUN_VIDEO_REDIS_URL`, au format explicite `NOM=valeur` sans expansion ni fichier temporaire. Les autres variables et syntaxe shell sont refusées avant toute application.
