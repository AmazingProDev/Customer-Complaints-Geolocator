#!/bin/bash

# Configuration
INPUT_TAB="public/Planet/4G_DEC_2021/LTE_Couverture downlink part10.tab"
OUTPUT_TIF="public/Planet/4G_DEC_2021/4G_Coverage.tif"

# Bounds (MinX MinY MaxX MaxY) - Matched to 2G Extent for consistency
TE_BOUNDS="-358450 2355150 1279950 3993550"
RESOLUTION="100 100" # 100m x 100m grid

echo "Starting optimization of 4G Data..."
echo "Input: $INPUT_TAB"
echo "Output: $OUTPUT_TIF"

# Check if GDAL is installed
if ! command -v gdal_rasterize &> /dev/null; then
    echo "Error: gdal_rasterize could not be found. Please install GDAL."
    exit 1
fi

# Run Conversion
# -a THRESHOLD: Burns the Value from this column
# -te: Target Extent
# -tr: Target Resolution
# -a_nodata: Sets -9999 as void
# -ot: Output Type Float32
gdal_rasterize -a THRESHOLD -te $TE_BOUNDS -tr $RESOLUTION -a_nodata -9999 -ot Float32 "$INPUT_TAB" "$OUTPUT_TIF"

echo "Done! Lightweight TIF created at $OUTPUT_TIF"
