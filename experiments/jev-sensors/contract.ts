export const SENSOR_ARMS = {
  'sensor-camera': { label: 'Pixels + marker', description: 'Camera pixels processed by ArUco/POSIT; no broadcasts, global position, surrounding depth or automatic aiming.' },
  'sensor-tfluna': { label: 'Pixels + marker + TF-Luna', description: 'Identical camera pipeline plus one fixed, downward-tilted TF-Luna beam. No object identity in range readings.' },
} as const;
export type SensorArm = keyof typeof SENSOR_ARMS;
