# Playing Card Detector

`playing-cards.onnx` is exported from:

- Model: `shrimantasatpati/yolov11_playing_cards_detection`
- Source: https://huggingface.co/shrimantasatpati/yolov11_playing_cards_detection
- Checkpoint: `detect/yolo11n_playing_cards/weights/best.pt`
- License tag on Hugging Face: MIT

Export command:

```sh
yolo export model=best.pt format=onnx imgsz=640 simplify=True opset=12
```

The browser scanner expects the raw YOLO output shape `[1, 56, 8400]`:

- 4 box attributes
- 52 card classes

## Image Processing Pipeline

1. The user chooses or captures a photo through the hidden file input behind `Scan hand`.
2. The browser decodes the image with `createImageBitmap`, then scales it down only if its longest edge is over 1800 px.
3. The scan canvas is letterboxed into a 640 x 640 YOLO input with neutral gray padding, preserving the original aspect ratio.
4. Pixel data is normalized from 0-255 to 0-1 and packed into an ONNX Runtime tensor shaped `[1, 3, 640, 640]` in RGB channel-first order.
5. ONNX Runtime Web loads lazily from jsDelivr and runs `models/playing-cards.onnx` with the WASM execution provider.
6. YOLO output is parsed into card boxes and class scores. Raw model output is handled directly, and NMS-shaped output is accepted for compatibility.
7. Low-confidence detections are discarded, duplicate boxes are reduced with non-max suppression, and duplicate card labels keep only the highest-confidence detection.
8. The highest-confidence cards needed for the current player count are sorted left to right before filling the dealt-card slots. Extra lower-confidence candidates are ignored.
