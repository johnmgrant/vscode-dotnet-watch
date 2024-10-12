import {
  Disposable,
  ProcessExecution,
  Task,
  TaskDefinition,
  TaskEndEvent,
  TaskExecution,
  TaskProcessStartEvent,
  TaskRevealKind,
  tasks,
  TextDocument,
  Uri,
  window,
  workspace,
} from "vscode";
import DotNetWatch from "../dotNetWatch";
import DotNetWatchDebugConfiguration from "../interfaces/IDotNetWatchDebugConfiguration";
import DotNetWatchTask from "../models/DotNetWatchTask";
import { ILaunchSettings } from "../models/LaunchSettings";

/**
 * The TaskService, provides functions to manage tasks.
 *
 * @export
 * @class TaskService
 */
export default class TaskService implements Disposable {
  /**
   * Creates an instance of TaskService.
   * @memberof TaskService
   */
  public constructor() {
    this.disposables = new Set<Disposable>();
    this.disposables.add(tasks.onDidEndTask(TaskService.TryToRemoveEndedTask));
    this.disposables.add(tasks.onDidStartTaskProcess(TaskService.IsWatcherStartedSetProcessId));
  }

  /**
   * A list of all disposables.
   *
   * @private
   * @type {Set<Disposable>}
   * @memberof TaskService
   */
  private disposables: Set<Disposable>;

  /**
   * Try's to remove the Task of the TaskEndEvent from cache.
   *
   * @private
   * @static
   * @param {TaskEndEvent} event
   * @memberof TaskService
   */
  private static TryToRemoveEndedTask(event: TaskEndEvent) {
    const taskId = DotNetWatchTask.GetIdFromTask(event.execution.task);
    if (taskId && taskId !== "") {
      DotNetWatch.Cache.RunningAutoAttachTasks.remove(taskId);
    }
  }

  /**
   * Check if the started process task is a watcher task, Sets it process id.
   *
   * @private
   * @static
   * @param {TaskProcessStartEvent} event
   * @memberof TaskService
   */
  private static IsWatcherStartedSetProcessId(event: TaskProcessStartEvent) {
    const taskId = DotNetWatchTask.GetIdFromTask(event.execution.task);
    if (DotNetWatch.Cache.RunningAutoAttachTasks.containsKey(taskId)) {
      const task = DotNetWatch.Cache.RunningAutoAttachTasks.getValue(taskId) as DotNetWatchTask;
      task.ProcessId = event.processId;
      DotNetWatch.Cache.RunningAutoAttachTasks.setValue(taskId, task);
    }
  }

  /**
   * Start a task.
   *
   * @private
   * @static
   * @param {Task} task
   * @memberof TaskService
   */
  private static StartTask(task: Task): void {
    if (!DotNetWatch.Cache.RunningAutoAttachTasks.containsKey(DotNetWatchTask.GetIdFromTask(task))) {
      const tmp = tasks.executeTask(task);
      tmp.then((k: TaskExecution) => {
        const autoTask: DotNetWatchTask = new DotNetWatchTask(k);
        DotNetWatch.Cache.RunningAutoAttachTasks.setValue(autoTask.Id, autoTask);
      });
    } else {
      DotNetWatch.UiService.TaskAlreadyStartedInformationMessage(task.definition.type.replace("Watch ", ""));
    }
  }

  /**
   * Generates a Task out of a AutoAttachDebugConfiguration and a project uri path.
   *
   * @private
   * @static
   * @param {DotNetWatchDebugConfiguration} config
   * @param {string} [project=""]
   * @returns {Task | undefined}
   * @memberof TaskService
   */
  private static async GenerateTask(config: DotNetWatchDebugConfiguration, projectUri: Uri): Promise<Task | undefined> {
    const name_regex = /(^.+)(\/|\\)(.+).csproj/;
    const matches = name_regex.exec(projectUri.fsPath);
    let projectName = "",
      launchSettingsPath = "";
    if (matches && matches.length === 4) {
      projectName = matches[3];
      launchSettingsPath = `${matches[1]}/Properties/launchSettings.json`;
    }
    const taskName = config?.taskName;
    if (!taskName) {
      await TaskService.TryLoadLaunchProfile(launchSettingsPath, config);
      const task: Task = new Task(
        { label: `Watch ${projectName}`, type: "DotNetWatch", presentation: { group: "dev" } } as TaskDefinition,
        config.workspace,
        `Watch ${projectName}`,
        "DotNet Auto Attach",
        new ProcessExecution("dotnet", ["watch", "--project", projectUri.fsPath, "run", ...config.args], {
          cwd: config.workspace.uri.fsPath,
          env: config.env,
        }),
        "$msCompile"
      );
      // Setting these gives a better experience when debugging.
      task.presentationOptions.reveal = TaskRevealKind.Silent;
      task.presentationOptions.showReuseMessage = false;
      return task;
    } else {
      const workspaceTasks = await tasks.fetchTasks();
      let dotnetWatchTask: Task | undefined = undefined;

      // Search for the task when taskname is specified.
      for (const t of workspaceTasks) {
        if (t.name === taskName) {
          dotnetWatchTask = t;
          break;
        }
      }

      if (dotnetWatchTask === undefined) DotNetWatch.UiService.GenericErrorMessage(`Error loading task [${taskName}]`);
      return dotnetWatchTask;
    }
  }

  private static async TryLoadLaunchProfile(launchSettingsPath: string, config: DotNetWatchDebugConfiguration) {
    try {
      const fulfilled = async (launchSettingsDocument: TextDocument) => {
        const launchSettings: ILaunchSettings = JSON.parse(launchSettingsDocument.getText());
        //naively attempt to load first launch profile, until we know how to handle compound launch configurations
        return launchSettings.profiles && Object.keys(launchSettings.profiles)[0];
      };

      const selectedLaunchProfile = await workspace.openTextDocument(launchSettingsPath).then(fulfilled);

      if (selectedLaunchProfile) {
        config.args = config.args.concat(`--launch-profile ${selectedLaunchProfile}`);
      }
    } catch (error) {
      if (!(<Error>error).message.startsWith("cannot open file"))
        DotNetWatch.UiService.GenericErrorMessage(
          `Error loading launch profile [${launchSettingsPath}]: ${(error as Error).message}`
        );
    }
  }

  /**
   * Checks the files which where found.
   *
   * @private
   * @param {Array<Uri>} filesFound
   * @returns {(Uri | undefined)}
   * @memberof TaskService
   */
  private CheckFilesFound(filesFound: Array<Uri>): Uri | undefined {
    filesFound.sort((a, b) => a.toString().length - b.toString().length);
    if (filesFound.length === 0 || filesFound.length > 1) {
      return undefined;
    } else {
      return filesFound[0];
    }
  }

  /**
   * Checks the Project config.
   *
   * @private
   * @param {string} project
   * @returns {(Thenable<Uri | undefined>)}
   * @memberof TaskService
   */
  private CheckProjectConfig(project: string): Thenable<Uri | undefined> {
    let decodedProject = project;
    const isCsproj = project.endsWith(".csproj");
    const workspaceFolderKeyword = "${workspaceFolder}";
    // if it is not a specific file, probably only a folder name.
    if (!isCsproj) {
      return workspace.findFiles(decodedProject + "/**/*.csproj").then(this.CheckFilesFound);
    }
    // this is definitely not the best way to search within workspace with user-specified ${workspaceFolder}
    if (decodedProject.startsWith(workspaceFolderKeyword)) {
      decodedProject = decodedProject.substring(workspaceFolderKeyword.length + 1);
    }
    const projectUri = Uri.file(decodedProject);

    if (workspace.workspaceFolders != null) {
      // probably full path, resolve like it is
      if (decodedProject.startsWith(workspace.workspaceFolders[0].uri.fsPath)) {
        return Promise.resolve(projectUri);
      } else {
        // if it is not a full path but only a name of a .csproj file
        return workspace.findFiles("**/" + decodedProject).then(this.CheckFilesFound);
      }
    }

    return Promise.resolve(undefined);
  }

  /**
   * Start DotNetWatchTask when no project is configured.
   *
   * @private
   * @param {DotNetWatchDebugConfiguration} config
   * @memberof TaskService
   */
  private StartDotNetWatchTaskNoProjectConfig(config: DotNetWatchDebugConfiguration): void {
    workspace.findFiles("**/*.csproj").then(async (k) => {
      const tmp = k.filter((m) => m.toString().startsWith(config.workspace.uri.toString()));
      if (tmp.length > 1) {
        DotNetWatch.UiService.OpenProjectQuickPick(tmp).then(async (s) => {
          if (s) {
            const task = await TaskService.GenerateTask(config, s.uri);
            if (task !== undefined) TaskService.StartTask(task);
          }
        });
      } else {
        const task = await TaskService.GenerateTask(config, tmp[0]);
        if (task !== undefined) TaskService.StartTask(task);
      }
    });
  }

  /**
   * Start DotNetWatchTask when project is configured.
   *
   * @private
   * @param {DotNetWatchDebugConfiguration} config
   * @memberof TaskService
   */
  private StartDotNetWatchTaskWithProjectConfig(config: DotNetWatchDebugConfiguration): void {
    this.CheckProjectConfig(config.project).then(async (projectUri) => {
      let task: Task | undefined;
      if (projectUri) {
        task = await TaskService.GenerateTask(config, projectUri);
        if (task !== undefined) TaskService.StartTask(task);
      }

      // If no project not found or it isn't unique show error message.
      if (task === undefined) {
        DotNetWatch.UiService.ProjectDoesNotExistErrorMessage(config).then((open) => {
          if (open) {
            workspace.findFiles("**/launch.json").then((files) => {
              if (files && files.length > 0) {
                workspace.openTextDocument(files[0]).then((doc) => window.showTextDocument(doc));
              }
            });
          }
        });
      }
    });
  }

  /**
   * Start a new DotNet Watch Task
   *
   * @param {DotNetWatchDebugConfiguration} config
   * @memberof TaskService
   */
  public StartDotNetWatchTask(config: DotNetWatchDebugConfiguration) {
    // Check if there is a no project configured
    if (!config.project || 0 === config.project.length) {
      this.StartDotNetWatchTaskNoProjectConfig(config);
    } else {
      this.StartDotNetWatchTaskWithProjectConfig(config);
    }
  }

  /**
   * Dispose.
   *
   * @memberof TaskService
   */
  public dispose() {
    this.disposables.forEach((k) => {
      k.dispose();
    });
    this.disposables.clear();
  }
}
