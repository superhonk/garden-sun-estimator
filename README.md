# Garden Sun Exposure Estimator

Garden Sun Exposure Estimator is a phone-first web tool for estimating how many hours of direct sunlight a particular garden spot can receive during each month of the growing season.

Choosing plants by eye can be difficult: buildings, fences, trees, and hedges block different parts of the Sun’s path as the seasons change. This tool maps the visible sky from the planting position, compares it with the Sun’s monthly path, and gives an approximate clear-sky sunlight range for that spot.

## Try it

Open [Garden Sun Exposure Estimator](https://superhonk.github.io/garden-sun-estimator/) on a supported phone. Camera, location, and motion-sensor access require HTTPS.

The project is an early feasibility prototype. Results are intended for gardening decisions, not architectural, engineering, legal, or solar-panel analysis.

## How to use it

1. Stand at the exact planting position and hold the phone near the expected height of the plant.
2. Allow camera, location, and orientation access when prompted. Images and calculations remain on the device.
3. Hold the phone upright in portrait mode and follow the highlighted Sun corridor.
4. Rotate from the same fixed position and pause briefly at each requested view while the app detects sky, tree canopy, and solid obstructions.
5. When coverage reaches 100%, the camera switches off automatically and the monthly results appear.
6. Select the months that match the local foliage and growing season.

## Understanding the result

Each month shows the average potential direct-sun hours per day under clear skies. Morning and afternoon confirmed sunlight are shown separately.

A range means that part of the Sun’s path crosses an uncaptured or mixed map area. A split category such as **Partial shade / partial sun** means the low and high ends of that range fall into different provisional plant-light categories. Use the measured hours as the primary result; plant requirements vary by species, climate, and time of day.

The prototype treats foliage-season tree canopy as opaque and ignores small openings between leaves. It does not account for cloud cover, weather, temporary objects, or seasonal leaf loss outside the selected months.

## Privacy

- No account is required.
- Camera images and precise location are not uploaded to a project server.
- Processing runs in the browser.
- Diagnostic data is downloaded only when the user explicitly chooses to export it.

## Contributing

Field-test reports, bug reports, design feedback, documentation improvements, and code contributions are welcome. Please [open a GitHub issue](https://github.com/superhonk/garden-sun-estimator/issues) before starting a large change so that the approach can be discussed.

See [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md) for the product goals, current implementation, assumptions, open decisions, and validation plan.

The project has no build step or installed package dependencies. Serve the repository with a local static web server and run the automated checks with:

```bash
npm test
```

Camera and sensor behavior should be tested from an HTTPS origin, such as the GitHub Pages deployment.

## License

The project's original source code and documentation are available under the [Apache License 2.0](./LICENSE). TensorFlow.js, the DeepLab model package, and ADE20K-related materials retain their own licenses or terms; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
