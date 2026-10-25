# Média natif embarqué

## SDK optionnels

`src/sdk-manifest.json` épingle les archives amont, leurs tailles, SHA-256,
révisions sources et ABI attendues. FFmpeg SDK 9.0.2 et la crate
`ffmpeg-sys-next` 9.0.1 sont deux versions distinctes. Les archives distribuées
dans `assets` sont des ZIP normalisés ; les archives `upstreamAssets` servent
uniquement à la factory. Aucun ZIP distribué n'est encore qualifié dans ce
manifeste.

Les scripts existants `scripts/aphrody/ffmpeg.ts` et `libmpv.ts` affichent
`sdk-plan` par défaut. `sdk-upstream-download` vérifie chaque téléchargement.
Sur la factory Linux, `sdk-normalize <target> <archive> <nouveau-répertoire>`
vérifie l'identité amont, extrait avec un outil natif, puis produit le ZIP et
`distribution.json`. Les fichiers pkg-config utilisent un préfixe relatif et
les fichiers exécutables conservent leurs permissions. Les liens internes sont
matérialisés ; les liens qui sortent du SDK sont refusés.

`sdk-download` et `sdk-extract` consomment exclusivement les ZIP distribués
épinglés. `sdk-verify <préfixe>` vérifie les en-têtes, bibliothèques, importlibs,
exécutables et notices de licence. Cette vérification des fichiers ne prouve
pas l'ABI du code exécuté. Le reçu `bun-sdk-receipt.json` contient les empreintes
des fichiers et conserve `nativeRuntimeABI: "not-yet-qualified"` avant les gates
natifs.

Les builds source passent par un propriétaire unique,
`scripts/aphrody/media-sdk-build.ts`. `plan`, `configure`, `build` et les commandes
`sdk-*` existantes conservent leurs entrées CLI. `sdk-build-plan <target>
<sources> <sortie>` donne les commandes et les prérequis sans compiler.
`sdk-build-native` exécute la recette de la plateforme native ; `sdk-build-linux`
réutilise le runner LLVM/sysroot des quatre cibles Linux. Les chemins restent
configurables par `BUN_FFMPEG_SOURCE`, `BUN_MPV_SOURCE`, `BUN_MEDIA_OUTPUT` et
`BUN_MEDIA_PREFIX`. Le chemin par défaut réutilise `vendor`, sans créer un second
checkout ni télécharger de sources à l'import.

Les huit noms sont `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`,
`linux-x64-musl`, `linux-arm64-musl`, `darwin-x64` et `darwin-arm64`. Windows utilise
MSVC/Clang-CL et le Bash natif de Git. Darwin utilise Xcode/Clang, Meson et une
cible minimale macOS 13. Les options LLVM/Linux restent dans
`media-sdk-linux.sh`. Chaque build demande le verrou de l'hôte dans
`BUN_MEDIA_HEAVY_LOCK`, deux jobs maximum et des délais bornés. Une recette
présente ne constitue pas une qualification native de cette cible.

`BUN_MEDIA_DEPENDENCY_PREFIXES` contient un objet JSON des préfixes existants,
par exemple `{"ffmpeg":"/chemin/ffmpeg","zlib":"/chemin/zlib"}`. Le reçu,
la cible native, les fichiers et les licences de chaque dépendance sont vérifiés
avant compilation. Le SDK zlib est zlib-rs (`src/zlib_rs`) compilé en bibliothèque
statique C : `include/`, `lib/libz.a` ou `lib/z.lib` et un `lib/pkgconfig/zlib.pc`
relocalisable. MPV réutilise les arbres
source existants libplacebo, fast_float, FreeType, FriBidi, HarfBuzz et libass.
Les pins, les hashes des arbres et les notices sont dans
`scripts/aphrody/media-sdk-sources.json`. Les headers de stubs Vulkan et leur
notice sont explicites via `BUN_MEDIA_VULKAN_HEADERS` et
`BUN_MEDIA_VULKAN_LICENSE` ; ce profil qualifie le chemin CPU/null uniquement.

Le registre distingue un checkout Git amont propre et un snapshot vendorizé
avec `UPSTREAM.json`, puis vérifie le contenu des sources. Les snapshots FFmpeg
et mpv actuellement intégrés sous `vendor` ont encore des pins différents du
catalogue SDK et sont donc refusés avant compilation. Les propriétaires GNU x64
déjà qualifiés sur la factory utilisent les pins du catalogue. Aucun résultat
GNU x64 ne qualifie les sept autres plateformes.

`bun run ffmpeg sdk-build-avio <target> <sources> <sortie>` compile le propriétaire
`packages/bun-video/native/Cargo.toml` avec le triple Rust exact,
`--locked --offline` et `filmcraft,libav,mpv`, puis installe
`bin/bun-video-native[.exe]` et `bin/bun_video_native.dll` ou
`lib/libbun_video_native.so`/`.dylib` dans le préfixe FFmpeg explicite. Les notices
des crates viennent des sources Cargo déjà présentes. Linux mesure son répertoire
GCC, sélectionne le linker du sysroot et compile le propriétaire C++ canonique
des wrappers GNU ; aucune bibliothèque de libc
de l'hôte n'est considérée comme portable par défaut. `gpu` reste une option
distincte, avec ses propres probes matériels.

La normalisation contrôle toutes les images : fermeture PE et architecture sur
Windows, fermeture ELF et plafond GLIBC 2.17 sur GNU, absence de symboles GLIBC
et loader musl sur musl, fermeture des load commands Mach-O sur Darwin. Les
dylibs utilisent `@rpath`, les chemins relatifs au loader sont réécrits par
`install_name_tool`, puis les images sont signées ad hoc. Ces contrôles statiques
ne remplacent pas les probes FFmpeg/MPV/AVIO, le décodage RGBA exact, l'audio et
l'exécution CLI. Le reçu de build reste `built-awaiting-native-ABI-closure-license-gates`.
Le packaging exige un reçu natif réussi avant de qualifier le SDK source.
`assets` reste vide jusqu'aux archives réellement construites, qualifiées et
publiées avec leur SHA et leur taille mesurée.

Le préfixe installé est `dirname(process.execPath)/lib/media/<ffmpeg|mpv>/<target>`
avec `bin`, `include`, `lib` et les notices de licence. La version figure dans le
reçu ; aucune ancienne version n'est conservée dans un second répertoire.
Les bindings FFI utilisent `bin` sur Windows et `lib` sur Linux. Un répertoire
de bibliothèques explicite ou `BUN_VIDEO_MEDIA_DIR` remplace cette découverte ;
`FFMPEG_DIR` désigne le préfixe complet pendant la compilation Rust.

## Exécutables embarqués

`scripts/media-plugin.ts` embarque les trois exécutables explicitement qualifiés
dans `BUN_VIDEO_NATIVE_EXECUTABLE`, `BUN_VIDEO_FFMPEG` et `BUN_VIDEO_FFPROBE`.
Sur Windows, FFmpeg et FFprobe doivent partager leur répertoire de DLL qualifié.

Le plugin lit leurs tables d'import PE et suit les dépendances transitives.
Il sélectionne uniquement les DLL adjacentes effectivement référencées dans
l'allowlist des bibliothèques FFmpeg, codecs, polices et runtimes associés.
Les autres DLL du dossier ne sont pas embarquées. Une dépendance média requise
manquante ou un import adjacent hors allowlist fait échouer la compilation.
Les bibliothèques système et pilotes restent celles de l'hôte qualifié.

Les DLL sélectionnées sont extraites dans le même répertoire temporaire privé
que les exécutables, avec leurs noms d'origine. Ce répertoire appartient au
processus et est supprimé à sa sortie. Cela préserve la résolution DLL Windows
du runtime FFmpeg sans modifier PATH global ni les bibliothèques système.

Le test du plugin vérifie la résolution des sections PE, la fermeture transitive,
l'exclusion d'une DLL étrangère et le refus d'une dépendance manquante. L'analyse
des imports ne remplace pas le gate réel d'exécution de l'artefact compilé.
