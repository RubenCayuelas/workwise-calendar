// Database models for metalworking shop scheduler

export interface Project {
  id: string;
  name: string;
  color: string;
  totalHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface Block {
  id: string;
  projectId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  duration: number; // in hours (can be decimal, e.g., 2.5)
  locked: boolean; // if true, won't move during auto-recomposition
  manuallyPlaced: boolean; // if true, was drag-dropped to Fri/weekend by user
  createdAt: string;
  updatedAt: string;
}

export interface Gap {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  duration: number; // in hours
  reason?: string; // optional: "Lunch", "Maintenance", etc.
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  workStartTime: string; // default "07:00", range 00:00-23:59
  workEndTime: string; // default "19:00", range 00:00-23:59
  defaultDayCapacity: number; // default 8 hours, range 1-12
  gapColor: string; // hex color for all gaps, e.g., "#CCCCCC"
}
