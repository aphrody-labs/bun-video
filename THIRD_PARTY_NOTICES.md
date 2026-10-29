# Bun Video source and dependency notices

The native HyperFrames capture adapter is retained from the Apache-2.0 source
integration at heygen-com/hyperframes commit
`063c2f8d61b4e989274b6526b370edc588b37e4a`. The complete Apache-2.0 text is
included in LICENSE. The native Remotion adapter and frame orchestration are
integration code from the Bun fork, whose original source is MIT licensed.

MIT permission notice for that original integration code:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The package's protocol adapters retain their individual SPDX notices. The
Crunchyroll adapter reimplements the exported API of community package
crunchyroll.js 1.1.1 (MIT), without its embedded application credentials. It
does not represent an official Crunchyroll SDK or grant access to content.

Bundled engine sources and external dependencies retain their own terms:

| Dependency                                                                            | Version                                      | Terms/source                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remotion, @remotion/renderer                                                          | 4.0.539                                       | [Remotion license](remotion/LICENSE.md), including applicable company licensing; the package includes the engine sources and Bun integration changes                                                                                                                                  |
| @hyperframes/core, @hyperframes/engine, @hyperframes/parsers                          | 0.8.214                                       | [Apache-2.0](https://github.com/heygen-com/hyperframes/blob/4719543e972548a261b8354f0a8dada479ae5d93/LICENSE)                                                                                                                                                                         |
| hls.js                                                                                | 1.7.4                                        | Apache-2.0, upstream package notices                                                                                                                                                                                                                                                  |
| dashjs                                                                                | 5.2.1                                        | BSD-3-Clause, upstream package notices                                                                                                                                                                                                                                                |
| fast-xml-parser                                                                       | 5.11.2                                       | MIT, upstream package notices                                                                                                                                                                                                                                                         |
| bitmovin-player                                                                       | 8.279.0                                      | [Bitmovin licensing](https://developer.bitmovin.com/playback/docs), requires the caller's valid player license and permitted deployment domain; upstream third-party notices apply                                                                                                    |
| react, react-dom                                                                      | 19.2.0                                       | MIT, upstream package notices                                                                                                                                                                                                                                                         |
| @aphrody/bun-runtime-sdk                                                              | 1.4.5                                        | Published package notices; native providers are distributed and qualified separately                                                                                                                                                                                                  |
| mediabunny                                                                            | 1.63.0                                         | [MPL-2.0](mediabunny/LICENSE), absorbed from [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny/tree/v1.63.0)                                                                                                                                                                |
| yt-dlp                                                                                | 2026.10.26                                   | [Unlicense](yt-dlp/LICENSE), absorbed from [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp/tree/2026.10.26); executed through `bun:python`/BUV                                                                                                                                       |
| mpv                                                                                   | git 88eb9f2                                  | [GPL-2.0-or-later/LGPL-2.1-or-later](../../vendor/mpv/LICENSE.GPL), forked from [mpv-player/mpv](https://github.com/mpv-player/mpv/tree/88eb9f2e73945d8bc9c133a2f67babaa9af34680); native shared-library FFI only                                                                     |
| gpu-video                                                                             | 0.4.0                                        | [MIT](https://github.com/software-mansion/smelter/blob/6637f3df71282c816140cd3bb9821d69b30be2ba/LICENSE), pinned from [software-mansion/smelter](https://github.com/software-mansion/smelter/tree/6637f3df71282c816140cd3bb9821d69b30be2ba/gpu-video); wgpu 30 hardware decode/encode |
| filmcraft-codecs, filmcraft-frame, filmcraft-media, filmcraft-time, filmcraft-isobmff | git cee1feb185e675a108f78067f71ad86a640ace3d | MIT OR Apache-2.0, [pinned FilmCraft source](https://github.com/aphrody-labs/filmcraft/tree/cee1feb185e675a108f78067f71ad86a640ace3d); native software decoding and MP4 remux used by `Bun.Video`                                                                                     |

Native Bun, JavaScriptCore, browser providers and media executables are not
included in this source package. Their distribution licenses remain separate.
