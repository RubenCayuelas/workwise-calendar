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
  // Split shift schedule (jornada partida)
  period1Start: string; // default "08:00", range 00:00-23:59
  period1End: string; // default "14:00", range 00:00-23:59
  period2Start: string; // default "15:30", range 00:00-23:59
  period2End: string; // default "19:30", range 00:00-23:59
  period2Enabled: boolean; // default true - if false, workday ends at period1End
  defaultDayCapacity: number; // default 10 hours (6h period1 + 4h period2), range 1-12
  // Visual margins for manual drag-drop (no auto-composition)
  visualMarginTop: number; // default 1 hour before period1Start, range 0-2
  visualMarginBottom: number; // default 1 hour after period2End, range 0-2
  gapColor: string; // hex color for all user-defined gaps, e.g., "#CCCCCC"
}
