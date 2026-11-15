# Synthetic ULog telemetry fixture

Generated with `python3 tools/make_telemetry_demo.py` from published ULog framing and supported topic-field conventions. This is a synthetic circular track, not a recorded flight or proof of sensor truth. It contains 128 global-position samples and 128 battery samples; timestamps are microseconds from an arbitrary boot clock. Latitude/longitude use degrees, altitude metres, north/east velocity metres/second, voltage volts. The native importer reads these bytes and produces ordinary FLTSEAL1 records and signed receipts.

SHA-256: `c14ad485d27db1f99643ca1030a5ee34f4233de02e1441b55db81eec566b97b9`
