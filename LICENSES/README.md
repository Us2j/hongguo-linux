# Third-party license texts

This directory contains the full license texts referenced by `NOTICE`.

| File / component | License | Text |
|---|---|---|
| `resources/ffmpeg` | GPL-3.0 | `GPL-3.0.txt` |
| `vendor/unidbg-libs.jar` | mixed; see `NOTICE` | `Apache-2.0.txt`, `GPL-2.0.txt`, `LGPL-2.1.txt`, `BSD-2-Clause.txt`, `BSD-3-Clause.txt`, `MIT.txt` |
| `signer/lib/libc++_shared.so` | Apache-2.0 WITH LLVM-exception | `Apache-2.0.txt`, `LLVM-exception.txt` |
| original project code | MIT | `../LICENSE` |

Sources of the texts:

- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0.txt
- GPL-2.0: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
- GPL-3.0: https://www.gnu.org/licenses/gpl-3.0.txt
- LGPL-2.1: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt
- BSD-2-Clause / BSD-3-Clause / MIT / LLVM-exception:
  https://github.com/spdx/license-list-data/tree/main/text

FFmpeg source:

- https://ffmpeg.org/
- https://ffmpeg.org/download.html
- https://johnvansickle.com/ffmpeg/

`vendor/unidbg-libs.jar` also contains its own `META-INF/LICENSE`,
`META-INF/LICENSE.txt`, and `META-INF/NOTICE.txt`. Keep those files when
redistributing the jar.

The proprietary ByteDance library and the third-party `unidbg-sign.jar` are
**not** covered by any license in this directory; see `NOTICE`.
