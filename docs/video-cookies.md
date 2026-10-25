# Cookies privés Bun Video

`VideoCookieVault` conserve l'entrée originale Crunchyroll chiffrée dans
`~/.aphrody/cookies/crunchyroll/cookies.sqlite`, distinct du catalogue curaté.
WebCrypto AES-256-GCM utilise un IV aléatoire de 12 octets et un tag de 128 bits.
La clé reste dans `Bun.secrets`, service `bun-video`, nom `cookie-vault.local` :
stockage protégé Windows Credential Manager sur ce poste.

`store(input)` conserve exactement le JSON fourni ; `decode()` retourne cette
entrée privée originale et `load()` ses cookies navigateur typés. `metadata()`
expose uniquement présence, algorithme, date et taille chiffrée. `delete()`
retire l'entrée chiffrée. Les valeurs décodées et en-têtes Cookie ne doivent
pas entrer dans les logs, le catalogue public ou les datasets.

`migrateVideoCookies(privateJSONPath)` vérifie l'égalité exacte après décodage
avant de supprimer le JSON plaintext. Une clé native manquante n'est pas
remplacée lorsqu'un ciphertext existe déjà. Aucun profil Chrome n'est copié.

`selectVideoCookies()` filtre domaine, hostOnly, chemin, secure et expiration.
`videoCookieHeader()` accepte uniquement les URLs HTTPS Crunchyroll autorisées.
`describeVideoCookies()` expose les noms et comptes, jamais les valeurs.
Le probe HTTP re-sélectionne explicitement les cookies à chaque redirection
autorisée, au plus trois requêtes en vingt secondes, sans suivre un autre domaine.
Une page HTTP 200 ne qualifie ni session authentifiée ni lecture vidéo.

L'entrée chiffrée `bun-video.env` utilise `storeEnvironment(text)` et
`loadEnvironment()` (texte exact). Sa clé native distincte est `env-vault.local`.
Le fichier absent n'est pas inventé : seule la configuration runtime réellement
sélectionnée est ajoutée explicitement, sans récupérer toutes les variables
d'environnement du poste.
