# The image example set

The three JSON files are the image example's requests, one per primitive. The four PNG files are the sample pictures the example attaches, in this order. Their names are plain numbers on purpose: the model reads each image's file name in its label (`Image 1: picture-1.png`), so a name such as `red-square.png` would give the answer away and the example would no longer show that the model looked at the picture.

1. `picture-1.png`: a red square on white.
2. `picture-2.png`: a blue circle on white.
3. `picture-3.png`: a green triangle on white.
4. `picture-4.png`: twelve overlapping shapes in several colours on a parchment background.

## Origin

DecisionMachines3000 drew these pictures itself with [`scripts/sample-images.ts`](../../../../scripts/sample-images.ts), which contains the shapes and the PNG encoder. Run `vp run sample-images` to draw them again. The pixels are deterministic; the compressed bytes may differ between Node versions, because each links its own zlib, which is why the test in `src/decision/examples.test.ts` compares the decoded pixels and not the files.

## Licence

To the extent possible under law, the authors of DecisionMachines3000 have dedicated these four pictures to the public domain under the [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) dedication. Use them for anything, with no attribution required.
