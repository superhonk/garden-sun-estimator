# Third-party notices

Garden Sun Exposure Estimator is licensed under the Apache License 2.0. That license applies to this repository's original source code and documentation. Third-party software, pretrained model files, and training datasets remain subject to their own licenses or terms.

## TensorFlow.js

The application loads TensorFlow.js 4.22.0 in the browser.

- Project: <https://github.com/tensorflow/tfjs>
- License: Apache License 2.0

## TensorFlow.js DeepLab

The application loads `@tensorflow-models/deeplab` 0.2.2 and uses its quantized ADE20K model option for on-device semantic segmentation.

- Project: <https://github.com/tensorflow/tfjs-models/tree/master/deeplab>
- Repository license: Apache License 2.0

## ADE20K

The selected DeepLab model is associated with the ADE20K scene-understanding dataset and label set. ADE20K is made available separately by the MIT CSAIL Computer Vision Group and has its own Terms of Use. The Apache License 2.0 for this repository does not replace or modify those terms.

- Dataset information and Terms of Use: <https://ade20k.csail.mit.edu/>
- Dataset repository: <https://github.com/CSAILVision/ADE20K>

Review the applicable upstream terms before redistributing pretrained model files, ADE20K data, annotations, or other dataset-derived assets. This repository currently loads the pretrained model at runtime and does not include the ADE20K dataset.
