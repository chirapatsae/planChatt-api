# Land-Use GeoJSON Overlay

This directory holds optional land-use GeoJSON files consumed at cold-start
by `CoordinateContextService` (`backend/src/ai/coordinate-context.service.ts`)
to classify a coordinate into one of the canonical area types used by the AI
coordinate-advisory pipeline.

Per CLAUDE.md §13, the resulting label is a SOFT signal for advisory only —
it MUST NOT block save or submit.

## Canonical area types

| Canonical value | Thai label         | Typical source tags                                   |
| --------------- | ------------------ | ----------------------------------------------------- |
| `agricultural`  | พื้นที่เกษตรกรรม   | `landuse=farmland \| agricultural \| orchard \| paddy` |
| `urban`         | พื้นที่เมือง       | `landuse=residential \| commercial \| industrial \| built_up` |
| `water`         | แหล่งน้ำ           | `landuse=reservoir`, `natural=water`, river/lake/canal |
| `forest`        | พื้นที่ป่า         | `landuse=forest`, `natural=wood`, national_park       |
| `community`     | พื้นที่ชุมชน       | derived from project-density heuristic (not GeoJSON) |
| `other`         | อื่น ๆ             | fallback — no polygon hit and no density signal       |

`community` is intentionally not derived from a polygon — it comes from the
nearby-project density heuristic inside `CoordinateContextService`.

## Expected file layout

- Place one or more `*.geojson` files directly under this directory.
- Each file MUST be a valid `FeatureCollection`.
- Each feature's `geometry` MUST be `Polygon` or `MultiPolygon` in WGS84
  (`EPSG:4326`) — the same CRS used by every other GeoJSON in the repo.
- Each feature's `properties` MUST carry ONE of the following keys naming the
  land-use class:
  - `landuse` (preferred — OSM-style)
  - `LANDUSE`
  - `area_type` / `AREA_TYPE`
  - `class` / `CLASS`

Accepted values are normalized case-insensitively by
`CoordinateContextService.normalizeLanduse` — see that method for the full
mapping. Unknown tags collapse to `other` and are dropped at load time.

### Example

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "landuse": "reservoir", "name": "อ่างเก็บน้ำลำตะคอง" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[101.8, 14.7], [101.9, 14.7], [101.9, 14.8], [101.8, 14.8], [101.8, 14.7]]]
      }
    }
  ]
}
```

## Loader behavior

- The loader scans every `*.geojson` under this directory at module bootstrap.
- Features with unparseable or non-polygon geometries are skipped with a warn log.
- A lake carved out of a forest polygon should be encoded either as a separate
  `water` feature or as a hole in the forest `MultiPolygon` — the PIP routine
  honours ring parity (holes count as outside), matching `GeoBoundaryService`.
- Missing directory or empty directory is non-fatal; the classifier falls
  through to the density + boundary heuristic (Layer B) and finally to
  `other` (Layer C).

## Constraints

- No outbound HTTP — files are loaded from disk only.
- Target cold-start budget: < 1 second total, so cap each file at ~5 MB and
  pre-simplify via mapshaper if needed.
- DO NOT ship PII or unlicensed cadastral data — repo assets only.
- DO NOT add nation-wide coverage in v1; start with Nakhon Ratchasima.
