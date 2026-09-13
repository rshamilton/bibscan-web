# Third-party components

bibscan-web itself is MIT licensed (see [LICENSE](LICENSE)). It ships these
third-party files unmodified:

## PP-OCR models — Apache License 2.0

`public/models/det.onnx`, `cls.onnx`, `rec.onnx` and the character list in
`rec_keys.json` (extracted from `rec.onnx`'s metadata).

These are PaddleOCR's PP-OCRv4 mobile detection and recognition models and the
PP-OCR mobile v2.0 angle classifier, converted to ONNX and distributed with
[RapidOCR](https://github.com/RapidAI/RapidOCR) (`rapidocr-onnxruntime` 1.4.4).

- PaddleOCR: Copyright (c) 2020 PaddlePaddle Authors — https://github.com/PaddlePaddle/PaddleOCR
- RapidOCR: Copyright (c) RapidAI — https://github.com/RapidAI/RapidOCR

Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0

The detector post-processing, angle classification and recogniser decoding in
`public/js/ocr/` are JavaScript ports of RapidOCR's (Apache-2.0) Python
pre/post-processing.

## ONNX Runtime Web — MIT License

`public/vendor/ort/ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`,
`ort-wasm-simd-threaded.wasm` — onnxruntime-web 1.29.0, byte-identical to the
npm release (checked by `tests/unit/app_files.test.mjs`).

```
MIT License

Copyright (c) Microsoft Corporation

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
```

## Image operations

`public/js/ocr/image.js` reimplements, from their documented behaviour, the
handful of OpenCV operations the models expect (resampling, perspective warps,
CLAHE, 8-bit Lab). The test suite compares them against OpenCV's own output.

## Race data

Race rosters and results come from Athlinks' and RunSignUp's public results
endpoints, fetched on your request through the local server. They are not
part of this software. Athlinks, ChronoTrack and RunSignUp are trademarks of
their respective owners; bibscan-web is an independent, unaffiliated project
and is not sponsored by or endorsed by any of them.
