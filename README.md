# Garden Sun Exposure Estimator

## Project status

This document is the living project description and source of truth for the product. It should be updated whenever the product scope, assumptions, requirements, or technical approach changes.

The project is currently in the definition and prototyping stage.

The repository now contains a phone-first capture feasibility prototype. It includes a browser capability check, live rear-camera capture, location and orientation diagnostics, on-device ADE20K semantic segmentation, conservative closing of small canopy gaps, an approximate azimuth/elevation obstruction map, local diagnostic export, an installable web-app manifest, basic offline caching, and an automated GitHub Pages deployment workflow. It does not yet calculate monthly sunlight.

## Summary

Garden Sun Exposure Estimator is a phone-first website that helps gardeners estimate how much direct sunlight a specific location in their garden can receive during each relevant month of the foliage and growing season.

Standing at the location being evaluated, the user follows a guided camera sweep of the surrounding sky. The application identifies buildings, fences, trees, hedges, and other obstructions; maps those obstructions to their direction and elevation; calculates the Sun's path for the location; and estimates when the Sun would be visible or blocked.

The result helps the gardener decide whether the location is suitable for sun-loving, partial-sun, partial-shade, or shade-tolerant plants during the months that matter for those plants.

The application is intended to be a focused utility. It will not require user accounts, and it should perform its calculations and image processing on the user's device without server-side processing.

## Product goal

Help a gardener make a useful planting decision in a few minutes, without specialist equipment or knowledge of solar geometry.

The application should answer:

- How many hours of potential direct sunlight does this spot receive in each month?
- At what times of day is direct sunlight available?
- Which directions or objects cause the most shade?
- Which broad light category best describes the spot during the relevant growing season?
- How reliable is the estimate?

## Important definition

The application estimates **potential direct sunlight under clear-sky conditions**.

It does not predict actual weather-dependent sunshine, diffuse or reflected light, soil conditions, temperature, or plant performance. Its plant-light classification is guidance rather than a guarantee.

Annual averaging is deliberately not a primary result. Many plants are dormant outside their growing season, so exposure must be displayed by month and interpreted for the months relevant to the plant or planting decision.

## Intended users

The primary users are home gardeners evaluating beds, balconies, patios, greenhouses, allotments, and container locations.

Users are assumed to have a reasonably modern smartphone but should not need to understand compass bearings, solar angles, photography, or surveying.

## Product principles

- **Phone first:** The complete assessment must be practical on a phone and outdoors.
- **No account required:** A user can perform an assessment without registering or signing in.
- **Local by default:** Captured images, location data, segmentation, and solar calculations remain on the device whenever technically possible.
- **Useful over falsely precise:** Results include uncertainty and clearly state important limitations.
- **Seasonally relevant:** Monthly results take priority over annual summaries.
- **Conservative around trees:** During the foliage season, tree canopies are treated as stable, opaque shade rather than as collections of temporary sun gaps.
- **Focused tool:** Avoid social, community, advertising, and account-management features that do not support the core assessment.
- **Static hosting:** The application should be deployable as a static site on GitHub Pages.

## Primary user journey

1. The user starts a new garden-spot assessment.
2. The application briefly explains what will be measured and why camera, location, and orientation access are needed.
3. The user stands at the spot, holding the phone approximately at the intended plant height.
4. The application checks sensor availability and helps the user calibrate direction and level the phone.
5. A guided capture asks the user to sweep across the entire region through which the Sun may travel.
6. The application combines the captured views into a directionally aligned obstruction map.
7. Sky and non-sky areas are detected automatically on the device.
8. The user reviews the detected outline and corrects obvious mistakes if necessary.
9. The user confirms the months that represent the local foliage or growing season.
10. The application calculates solar positions for those months and compares them with the obstruction map.
11. The user receives monthly sunlight estimates, time-of-day breakdowns, a plant-light category, and a confidence rating.
12. The user may save the assessment locally on the device, export it, or discard it.

## Measurement approach

Each point in the captured view must correspond to:

- an azimuth, meaning its compass direction;
- an elevation angle above the horizon; and
- a classification such as open sky, definite obstruction, or uncertain.

For each evaluated time, the application calculates the Sun's azimuth and elevation using the location, date, and time. If the Sun's position falls within open sky, that time contributes to the estimated direct-sun duration. If it falls behind an obstruction, it contributes to shade.

The calculation should account for the apparent size of the Sun and an uncertainty margin rather than testing only a single mathematical point.

The capture must cover the full relevant sun-path corridor, not only the southern horizon. Depending on latitude, season, and hemisphere, the Sun may appear well north of east or west, and overhead branches may also cause shade.

## Calculation and presentation

Solar calculations are inexpensive enough to evaluate every day within the selected foliage-season months, or several representative days per month, without a backend. The precise sampling method remains to be validated.

Calculations should use intervals of one or two minutes where practical. A five-minute interval may be acceptable for an early prototype but introduces avoidable rounding around transitions between sunlight and shade.

Results should include:

- potential direct-sun hours for each selected foliage-season month;
- a representative daily value or range within each month;
- typical morning and afternoon exposure;
- approximate first-sun and last-sun times;
- a visual monthly exposure chart;
- the primary sources of obstruction; and
- an overall confidence level.

The interface must let the user confirm which months constitute the relevant foliage or growing season. It may provide a location-appropriate default, but the user must be able to change it. Late fall and winter are outside the MVP calculation by default, and the main result must not be reduced to a whole-year average.

## Plant-light classification

Light categories should be configurable rather than presented as universal botanical rules.

Possible defaults are:

- Full sun: approximately 6 or more hours of direct sunlight per day
- Partial sun: approximately 4-6 hours
- Partial shade: approximately 2-4 hours
- Shade: less than approximately 2 hours

The measured monthly hours should always be shown alongside any label. Plant requirements vary by climate, species, season, and whether the exposure occurs in the morning or during the hotter afternoon.

A later version may allow the user to select a plant or its active growing months, but a plant database is not required for the initial product.

## Functional requirements

### Permissions and compatibility

- Request camera, location, and orientation permissions only when needed.
- Explain the benefit of each permission before requesting it.
- Serve the application over HTTPS, as required for browser access to camera, geolocation, and orientation features.
- Detect unsupported or unreliable sensors before capture.
- Provide clear recovery instructions after a denied permission.
- Provide a manual direction or uploaded-panorama fallback where practical.

### Guided capture

- Prefer the rear-facing camera.
- Ask the user to capture from the exact planting position and approximate plant height.
- Guide the user through both horizontal direction and vertical coverage.
- Indicate captured, missing, and low-quality areas.
- Detect movement that is too fast, excessive phone tilt, blur, and insufficient overlap where possible.
- Allow the capture to be repeated.

### Obstruction detection

- Distinguish open sky from solid obstructions on the user's device.
- Distinguish tree canopy from other obstruction types where practical.
- Treat foliage-season tree canopies as opaque obstructions.
- Close small openings inside a detected canopy so that temporary gaps between leaves or branches do not add direct-sun time.
- Preserve meaningful open-sky areas around the canopy rather than applying the same gap-closing rule to the entire image.
- Use an angular rather than purely pixel-based threshold for small openings so behavior remains consistent across cameras and resolutions. The threshold must be chosen through field testing.
- Mark uncertain regions rather than silently making a confident binary decision.
- Provide a simple brush or outline editor for corrections.
- Consider user-marked deciduous trees and separate leaf-on or leaf-off assessments in a later version.

### Solar calculation

- Use latitude, longitude, date, time zone, and daylight-saving rules correctly.
- Calculate solar azimuth and elevation throughout the selected period.
- Ignore times when the Sun is below the effective horizon.
- Compare the solar disk or an uncertainty envelope with the obstruction map.
- Keep calculation logic independent from the user-interface layer so it can be tested thoroughly.
- Perform calculations locally in the browser.

### Results and local persistence

- Prioritize monthly exposure and a simple planting interpretation.
- Show only the selected foliage or growing-season months by default.
- Separate morning and afternoon sun.
- Explain that the estimate assumes clear skies and the currently captured obstructions.
- Display confidence and the factors lowering it.
- Allow assessments to be saved locally without an account.
- Allow users to rename, compare, repeat, export, and delete locally saved assessments.
- Clearly explain that clearing browser data may remove locally saved assessments unless they were exported.

## Technical and hosting constraints

- The application will be a static website suitable for GitHub Pages.
- The core experience must not depend on a custom application server, serverless functions, or a database.
- The application must not require authentication or user accounts.
- Image segmentation, panorama processing, solar calculations, and persistence should run in the browser.
- Suitable browser technologies may include Canvas, Web Workers, WebAssembly, IndexedDB, and installable Progressive Web App features.
- The design should tolerate limited or absent network access after the application has loaded.
- Any third-party dependency must be suitable for public client-side distribution and must not require embedding a private API key.
- The repository must not contain captured garden images, precise user locations, secrets, or analytics data.

### Current feasibility-prototype approach

- Use the browser's native camera stream rather than recording and stitching a complete video.
- Sample selected camera frames as the user rotates through two passes: one near the horizon and one angled upward.
- Associate each sample with browser-provided heading, elevation, and roll readings.
- Use the quantized TensorFlow.js DeepLab ADE20K model to distinguish sky, trees or plants, and other obstructions on the device.
- Treat small sky regions enclosed primarily by detected canopy as tree shade.
- Project classified pixels into a coarse 360-by-90-degree angular grid using an adjustable assumed camera field of view.
- Combine overlapping frame classifications by voting and export the resulting diagnostic grid locally.
- Download the pinned TensorFlow.js library and model weights when the prototype is first used. Camera frames are not uploaded. Self-hosting approved model assets remains a production decision.

This approach is provisional. Mobile field tests must determine whether browser orientation readings and assumed camera geometry are stable enough. If not, frame-to-frame feature matching or an explicit camera calibration step will be required.

## Non-functional requirements

- Controls and instructions must remain legible in bright sunlight.
- Capture feedback should be understandable without sound.
- The interface should support one-handed use where possible.
- Processing should feel responsive and show progress during longer operations.
- Computationally expensive work should not freeze the interface.
- Battery, heat, memory, and mobile-data consumption should be kept modest.
- Accessibility should include large touch targets, sufficient contrast, screen-reader labels, and instructions that do not rely only on color.
- The application should support the current major versions of mobile Safari and Chrome, subject to a documented compatibility test matrix.

## Privacy model

Garden images and precise location data are sensitive. The product should therefore follow these rules:

- Process captured images locally.
- Do not upload captures or coordinates to a project-controlled server.
- Do not require an account or personal profile.
- Store saved assessments only on the device unless the user explicitly exports them.
- Explain what is stored and provide an obvious way to delete it.
- Avoid third-party analytics that receive precise coordinates, images, or assessment content.
- If privacy-preserving analytics are introduced later, they must be optional or limited to non-sensitive product events.

## Assumptions

- The user captures the view from the exact location being assessed.
- The phone is held near the height of the plant or foliage being considered.
- The phone's camera and motion sensors provide enough information for an approximate angular obstruction map.
- Major obstructions remain reasonably static after capture.
- The MVP is used when deciduous trees have foliage and assumes the captured canopy represents shade throughout the selected months.
- Small openings within a tree canopy are not sufficiently stable from year to year to count toward a long-term direct-sun classification.
- Clear-sky direct-sun duration is a useful first-order indicator of plant suitability.
- The estimate is for gardening decisions, not engineering, architectural, legal, or solar-panel analysis.
- Users will accept a guided capture lasting a few minutes when its purpose and progress are clear.

## Known limitations

- Compass readings may be distorted by metal, buildings, or the device itself.
- Absolute orientation support and behavior vary between mobile browsers.
- Camera field of view and orientation metadata differ between devices.
- Automatic segmentation may misclassify canopy edges, reflective surfaces, netting, or translucent foliage.
- Wind can move vegetation during capture.
- The MVP does not estimate late-fall or winter exposure after deciduous trees lose their leaves.
- Treating tree canopies as opaque intentionally underestimates brief sunlight through small openings.
- Nearby obstacles may be represented poorly if the user changes position while capturing.
- Cloud cover, fog, local climate, and temporary shade are not represented.
- Low-angle sunlight may be weakened by atmospheric conditions even when geometrically visible.
- Duration alone does not measure total solar energy or photosynthetically active radiation.

## MVP scope

The first version should prove that the measurement is useful before attempting every possible automation.

The MVP should include:

- phone-browser compatibility checking;
- a clear camera, location, and orientation permission flow;
- guided capture of the relevant sky region;
- direction and phone-level guidance;
- on-device sky-versus-obstruction detection;
- canopy-aware removal of small sky openings within foliage;
- manual mask correction;
- local solar-path calculations;
- direct-sun estimates for each selected foliage-season month;
- foliage or growing-season month selection;
- morning-versus-afternoon results;
- configurable plant-light categories;
- a visible confidence rating; and
- optional local saving and export without an account.

The following are outside the initial MVP:

- user accounts and authentication;
- server-side image processing or storage;
- a custom backend or database;
- social and community features;
- advertising;
- a comprehensive plant database;
- weather-adjusted sunshine predictions;
- advanced light-intensity modeling; and
- cross-device synchronization;
- late-fall and winter estimates through deciduous trees; and
- user-marked trees with seasonal opacity rules.

## Validation plan

Accuracy should be evaluated separately for orientation, obstruction detection, and final sun-duration estimates.

A practical validation study should:

- test several iPhone and Android models;
- include open gardens, buildings, fences, deciduous trees, dense evergreen foliage, and balconies;
- compare predicted sun and shade transitions with time-lapse observations or a physical light sensor;
- test across the local leaf-on season and include different canopy densities;
- record failure rates during permission and capture steps;
- compare repeated captures from the same spot; and
- measure whether gardeners interpret the monthly result correctly.

A provisional target is a daily direct-sun estimate within approximately 30 minutes under uncomplicated conditions. Field testing must determine whether that is achievable and useful. The product should show lower confidence when capture or sensor data cannot support the target.

## Success measures

The product is successful when:

- most supported users can complete an assessment without assistance;
- users understand the monthly results and clear-sky limitation;
- repeated captures at the same spot produce similar results;
- estimates distinguish meaningfully between sunny, partially sunny, and shaded locations during the growing season;
- users report greater confidence in choosing a planting location;
- the tool remains useful without an account or network-backed service; and
- privacy-sensitive data is not transmitted or retained unnecessarily.

## Open decisions and highest-risk questions

- Whether a guided multi-image sweep, recorded video, conventional panorama, or optional fisheye approach produces the best obstruction map.
- How much vertical and horizontal coverage is required at each latitude.
- Whether compass data is sufficiently reliable or needs manual alignment or visual correction.
- Whether to calculate every day or a set of representative dates within each month.
- Whether a monthly result should be a value for the middle of the month, a monthly average of daily values, or a displayed range. This is distinct from an annual average, which is not planned.
- How partial occlusion of the solar disk should be counted.
- How users should correct segmentation errors outdoors.
- What angular opening size should be ignored within a detected canopy.
- How the application distinguishes a small gap within a canopy from a meaningful area of open sky.
- Whether future leaf-on and leaf-off captures should be linked as seasonal versions of the same spot.
- How the MVP suggests foliage-season months for a location while keeping them easy to change.
- Whether plant-light categories should use regional defaults, user-configurable rules, or both.
- What accuracy and confidence thresholds are acceptable for a public release.

## Reference material

- [Camera access in web browsers](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Browser geolocation](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)
- [Device orientation permission](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static)
- [NOAA solar calculation details](https://gml.noaa.gov/grad/solcalc/calcdetails.html)

## Repository structure

- `index.html` contains the initial application shell.
- `styles.css` contains the responsive visual styling.
- `app.js` contains permissions, live capture, on-device segmentation, obstruction-map assembly, diagnostic export, and service-worker registration.
- `geometry.mjs` contains canopy-gap closing and angular projection logic.
- `geometry.test.mjs` tests the geometry and canopy rules with Node's built-in test runner.
- `manifest.webmanifest` makes the site installable where supported.
- `service-worker.js` caches the application shell for repeat and limited offline use.
- `.github/workflows/deploy-pages.yml` deploys the static site to GitHub Pages after pushes to `main`.

## Local preview

The source has no installed package dependencies or build step. Serve the repository directory with any local static HTTP server and open the displayed address in a browser. The feasibility prototype downloads pinned TensorFlow.js scripts and model weights at runtime. Camera and location behavior should be tested on the final HTTPS GitHub Pages site or on a secure local development origin.

Run the local unit tests with `npm test`.

## GitHub Pages deployment

After this directory is pushed to a GitHub repository:

1. Open the repository's **Settings**, then **Pages**.
2. Set the Pages source to **GitHub Actions**.
3. Push to the `main` branch or manually run the **Deploy static site to GitHub Pages** workflow.

No secrets, backend services, package installation, or build commands are required for deployment.
