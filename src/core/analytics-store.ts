/** Persistent, workspace-scoped transfer analytics stored in VS Code user data. */
import * as path from 'path';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { TransferItem } from '../types';
import { TransferAnalytics } from './transfer-manager';

interface AnalyticsRecord {
  completedAt: string;
  direction: 'upload' | 'download';
  size: number;
  durationMs: number;
}

interface AnalyticsProject {
  id: string;
  name: string;
  records: AnalyticsRecord[];
}

interface AnalyticsFile { projects: AnalyticsProject[]; }

export type WorkspaceAnalytics = TransferAnalytics & {
  projects: Array<{ id: string; name: string }>;
};

export class AnalyticsStore extends EventEmitter implements vscode.Disposable {
  private readonly fileUri: vscode.Uri;
  private readonly directoryUri: vscode.Uri;
  private data: AnalyticsFile = { projects: [] };
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(globalStorageUri: vscode.Uri) {
    super();
    this.directoryUri = vscode.Uri.joinPath(globalStorageUri, 'analytics');
    this.fileUri = vscode.Uri.joinPath(this.directoryUri, 'transfers.json');
    this.ready = this.load();
  }

  public async record(item: TransferItem): Promise<void> {
    if (item.status !== 'completed' || !item.endTime) {return;}
    await this.ready;
    const folder = this.findWorkspace(item.localPath);
    if (!folder) {return;}
    const id = folder.uri.toString();
    let project = this.data.projects.find(candidate => candidate.id === id);
    if (!project) {
      project = { id, name: folder.name || path.basename(folder.uri.fsPath), records: [] };
      this.data.projects.push(project);
    }
    project.records.push({
      completedAt: item.endTime.toISOString(),
      direction: item.direction,
      size: Math.max(0, item.size || item.transferred || 0),
      durationMs: item.startTime ? Math.max(0, item.endTime.getTime() - item.startTime.getTime()) : 0
    });
    if (project.records.length > 1000) {project.records.splice(0, project.records.length - 1000);}
    await this.persist();
    this.emit('changed');
  }

  public async getAnalytics(projectId = 'all', days = 14): Promise<WorkspaceAnalytics> {
    await this.ready;
    const selected = projectId === 'all' ? this.data.projects : this.data.projects.filter(project => project.id === projectId);
    const today = new Date();
    const dayEntries = Array.from({ length: days }, (_, offset) => {
      const date = new Date(today); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (days - 1 - offset));
      return { date: date.toISOString().slice(0, 10), uploadedBytes: 0, downloadedBytes: 0, uploadedFiles: 0, downloadedFiles: 0 };
    });
    const byDate = new Map(dayEntries.map(entry => [entry.date, entry]));
    let uploadedFiles = 0, downloadedFiles = 0, uploadedBytes = 0, downloadedBytes = 0, totalDurationMs = 0;
    for (const record of selected.flatMap(project => project.records)) {
      const day = byDate.get(record.completedAt.slice(0, 10));
      if (!day) {continue;}
      totalDurationMs += record.durationMs;
      if (record.direction === 'upload') { uploadedFiles++; uploadedBytes += record.size; day.uploadedFiles++; day.uploadedBytes += record.size; }
      else { downloadedFiles++; downloadedBytes += record.size; day.downloadedFiles++; day.downloadedBytes += record.size; }
    }
    const completed = uploadedFiles + downloadedFiles;
    return { uploadedFiles, downloadedFiles, uploadedBytes, downloadedBytes, averageDurationMs: completed ? Math.round(totalDurationMs / completed) : 0, days: dayEntries, projects: this.data.projects.map(project => ({ id: project.id, name: project.name })).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  public dispose(): void { this.removeAllListeners(); }

  private findWorkspace(localPath: string): vscode.WorkspaceFolder | undefined {
    const normalized = path.resolve(localPath);
    return vscode.workspace.workspaceFolders?.find(folder => normalized === folder.uri.fsPath || normalized.startsWith(`${folder.uri.fsPath}${path.sep}`));
  }

  private async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (Array.isArray(parsed?.projects)) {this.data = { projects: parsed.projects.filter((project: any) => project && typeof project.id === 'string' && Array.isArray(project.records)) };}
    } catch {
      // The first run has no file yet; create it only after a completed transfer.
    }
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await vscode.workspace.fs.createDirectory(this.directoryUri);
      await vscode.workspace.fs.writeFile(this.fileUri, new TextEncoder().encode(JSON.stringify(this.data)));
    });
    return this.writeQueue;
  }
}
