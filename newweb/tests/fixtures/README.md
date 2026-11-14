`synthetic-sync.mp4` is a generated 10-second 160x90 solid-blue H.264 clip, not flight footage.
It lets browser tests decode and seek real media without mocking HTMLMediaElement metadata.

Generated with FFmpeg 5.1.9:

```sh
ffmpeg -f lavfi -i color=c=blue:s=160x90:r=24:d=10 -c:v libx264 -pix_fmt yuv420p -threads 2 -movflags +faststart synthetic-sync.mp4
```
