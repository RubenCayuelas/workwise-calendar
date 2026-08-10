// Database models
export interface Client {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  clientId: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  estimatedHours: number;
  actualHours: number;
}

export interface Block {
  id: string;
  taskId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  duration: number; // in hours
  locked: boolean;
}

export interface Gap {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  duration: number; // in hours
  reason: string;
}
