/** Calibration math only. No world access, future motion, mission goal or candidate actions. */
export function measuredGeometry(camera: any) {
  if (!camera?.detections?.length) return [];
  const h = camera.headingDeg * Math.PI / 180, p = camera.pitchDeg * Math.PI / 180;
  return camera.detections.map((d: any) => {
    const convert = (t: number[], r: number[][]) => {
      // Marker right = rover right; marker up = rover forward. Pose uses camera right/up/depth.
      const dot = (column: number) => r.reduce((sum, row, i) => sum + row[column]! * t[i]!, 0);
      const ahead = -dot(1), left = dot(0), above = Math.abs(dot(2)) + .092;
      const right = r[0]![1]!, up = r[1]![1]!, forward = r[2]![1]!;
      const east = right * Math.sin(h) - up * Math.cos(h) * Math.sin(p) + forward * Math.cos(h) * Math.cos(p);
      const north = -right * Math.cos(h) - up * Math.sin(h) * Math.sin(p) + forward * Math.sin(h) * Math.cos(p);
      return { droneAheadOfRoverM: ahead, droneLeftOfRoverM: left, droneAboveRoverM: above, separationM: Math.hypot(ahead, left, above),
        roverHeadingDeg: Math.atan2(north, east) * 180 / Math.PI };
    };
    return { basis: 'Measured pixel pose plus known roof-marker mounting and onboard attitude; not world truth or prediction',
      ambiguous: d.ambiguous, best: convert(d.translationM, d.rotation), alternative: convert(d.alternative.translationM, d.alternative.rotation),
      cameraTargetRightDeg: d.bearingRightDeg, cameraTargetUpDeg: d.bearingUpDeg };
  });
}
