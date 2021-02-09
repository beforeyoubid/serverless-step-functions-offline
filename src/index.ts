import _ from 'lodash';
import path from 'path';
import moment from 'moment';
import Plugin from 'serverless/classes/Plugin';

import {
  StateMachine,
  Options,
  ServerlessWithError,
  ContextObject,
  Failure,
  StateDefinition,
  Maybe,
  Event,
  Callback,
  Branch,
  ChoiceInstance,
  ChoiceConditional,
  StateValueReturn,
  definitionIsHandler,
  stateIsChoiceConditional,
} from './types';
import enumList from './enum';

export default class StepFunctionsOfflinePlugin implements Plugin {
  private location: string;

  private functions: ServerlessWithError['service']['functions'];
  private detailedLog: Options['detailedLog'];
  eventFile: Options['event'] | Options['e'];
  loadedEventFile: Maybe<Event>;
  variables?: {
    [key: string]: string;
  };
  private environmentVariables: {
    [key: string]: string | undefined;
  } = {};
  private cliLog: (str: string) => void;
  stateDefinition?: StateMachine['definition'];

  private mapResults: unknown[] = [];
  private eventForParallelExecution?: Event;
  private currentStateName: Maybe<string>;
  private currentState: Maybe<StateDefinition>;
  private contextObject: Maybe<ContextObject>;
  private subContextObject: Maybe<ContextObject>;
  private subStates: StateMachine['definition']['States'] = {};
  private states: StateMachine['definition']['States'] = {};
  private parallelBranch: Maybe<Branch>;
  private eventParallelResult: Event[] = [];

  serverless: ServerlessWithError;
  options: Options;
  commands: Plugin['commands'];
  hooks: Plugin['hooks'];
  stateMachine: Options['stateMachine'];

  environment = '';

  constructor(serverless: ServerlessWithError, options: Options) {
    this.location = process.cwd();
    this.serverless = serverless;
    this.options = options;
    this.stateMachine = this.options.stateMachine;
    this.detailedLog = (this.options.detailedLog || this.options.l) ?? false;
    this.eventFile = this.options.event || this.options.e;
    this.functions = this.serverless.service.functions;
    this.variables = this.serverless.service.custom?.stepFunctionsOffline;
    this.cliLog = this.serverless.cli.log.bind(this.serverless.cli);
    this.commands = {
      'step-functions-offline': {
        usage: 'Will run your step function locally',
        lifecycleEvents: [
          'checkVariableInYML',
          'start',
          'isInstalledPluginSLSStepFunctions',
          'findFunctionsPathAndHandler',
          'findState',
          'loadEventFile',
          'loadEnvVariables',
          'buildStepWorkFlow',
        ],
        options: {
          stateMachine: {
            usage: 'The stage used to execute.',
            required: true,
          },
          event: {
            usage: 'File where is values for execution in JSON format',
            shortcut: 'e',
          },
          detailedLog: {
            usage: 'Option which enables detailed logs',
            shortcut: 'l',
          },
        },
      },
    };

    this.hooks = {
      'step-functions-offline:start': this.start.bind(this),
      'step-functions-offline:isInstalledPluginSLSStepFunctions': this.isInstalledPluginSLSStepFunctions.bind(this),
      'step-functions-offline:findState': this.findState.bind(this),
      'step-functions-offline:loadEventFile': this.loadEventFile.bind(this),
      'step-functions-offline:loadEnvVariables': this.loadEnvVariables.bind(this),
      'step-functions-offline:buildStepWorkFlow': this.buildStepWorkFlow.bind(this),
    };
  }

  // Entry point for the plugin (sls step offline)
  start(): void {
    this.cliLog('Preparing....');

    this._getLocation();
    this._checkVersion();
    this._checkVariableInYML();
  }

  _getLocation(): void {
    if (this.options.location) {
      this.location = path.join(process.cwd(), this.options.location);
    }
    if (this.variables && this.variables.location) {
      this.location = path.join(process.cwd(), this.variables.location);
    }
  }

  _checkVersion(): void {
    const version = this.serverless.version;
    if (!version.startsWith('1.')) {
      throw new this.serverless.classes.Error(
        `Serverless step offline requires Serverless v1.x.x but found ${version}`
      );
    }
  }

  _checkVariableInYML(): void {
    if (!_.has(this.serverless.service, 'custom.stepFunctionsOffline')) {
      throw new this.serverless.classes.Error('Please add ENV_VARIABLES to section "custom"');
    }
    return;
  }

  isInstalledPluginSLSStepFunctions(): void {
    const plugins = this.serverless.service.plugins;
    if (plugins.indexOf('serverless-step-functions') < 0) {
      const error = 'Error: Please install plugin "serverless-step-functions". Package does not work without it';
      throw new this.serverless.classes.Error(error);
    }
  }

  async loadEventFile(): Promise<void> {
    if (!this.eventFile) {
      this.eventFile = '';
      return Promise.resolve();
    }
    try {
      this.loadedEventFile = path.isAbsolute(this.eventFile)
        ? await import(this.eventFile)
        : await import(path.join(process.cwd(), this.eventFile));
    } catch (err) {
      throw err;
    }
  }

  loadEnvVariables(): void {
    // this.environment = this.serverless.service.provider.environment;
    process.env.STEP_IS_OFFLINE = 'true';
    process.env = _.extend(process.env, this.environment);
    this.environmentVariables = Object.assign({}, process.env); //store global env variables;
    return;
  }

  findState(): Promise<void> {
    this.cliLog(`Trying to find state "${this.stateMachine}" in serverless manifest`);
    return this.parseConfig()
      .then(() => {
        if (!this.stateMachine) {
          throw new Error('unable to get state definition');
        }
        this.stateDefinition = this.getStateMachine(this.stateMachine).definition;
      })
      .catch((err: Error) => {
        throw new this.serverless.classes.Error(err.message);
      });
  }

  getRawConfig(): Promise<any> {
    const serverlessPath = this.serverless.config.servicePath;
    if (!serverlessPath) {
      throw new this.serverless.classes.Error('Could not find serverless manifest');
    }

    const manifestFilenames = ['serverless.yaml', 'serverless.yml', 'serverless.json', 'serverless.js'];

    const manifestFilename = manifestFilenames
      .map(filename => path.join(serverlessPath, filename))
      .find(filename => this.serverless.utils.fileExistsSync(filename));

    if (!manifestFilename) {
      throw new this.serverless.classes.Error(
        `Could not find serverless manifest at path ${serverlessPath}. If this path is incorreect you should adjust the 'servicePath' variable`
      );
    }

    if (/\.json|\.js$/.test(manifestFilename)) {
      return import(manifestFilename);
    }

    return this.serverless.yamlParser.parse(manifestFilename);
  }

  parseConfig(): Promise<void> {
    return this.getRawConfig().then(serverlessFileParam => {
      this.serverless.service.stepFunctions = {};
      this.serverless.service.stepFunctions.stateMachines =
        serverlessFileParam.stepFunctions && serverlessFileParam.stepFunctions.stateMachines
          ? serverlessFileParam.stepFunctions.stateMachines
          : {};
      this.serverless.service.stepFunctions.activities =
        serverlessFileParam.stepFunctions && serverlessFileParam.stepFunctions.activities
          ? serverlessFileParam.stepFunctions.activities
          : [];

      if (!this.serverless.pluginManager.cliOptions.stage) {
        this.serverless.pluginManager.cliOptions.stage =
          this.options.stage || (this.serverless.service.provider && this.serverless.service.provider.stage) || 'dev';
      }

      if (!this.serverless.pluginManager.cliOptions.region) {
        this.serverless.pluginManager.cliOptions.region =
          this.options.region ||
          (this.serverless.service.provider && this.serverless.service.provider.region) ||
          'us-east-1';
      }

      // this.serverless.variables.populateService(this.serverless.pluginManager.cliOptions);
      this.serverless.variables.populateService();
      return Promise.resolve();
    });
  }

  getStateMachine(stateMachineName: string): StateMachine {
    if (
      this.serverless.service.stepFunctions?.stateMachines &&
      stateMachineName in this.serverless.service.stepFunctions.stateMachines
    ) {
      return this.serverless.service.stepFunctions?.stateMachines[stateMachineName];
    }
    throw new this.serverless.classes.Error(`stateMachine "${stateMachineName}" doesn't exist in this Service`);
  }

  // findFunctionsPathAndHandler() {
  //     for (const functionName in this.variables) {
  //         const functionHandler = this.variables[functionName];
  //         const {handler, filePath} = this._findFunctionPathAndHandler(functionHandler);
  //
  //         this.variables[functionName] = {handler, filePath};
  //     }
  //     console.log('this.va', this.variables)
  // },
  //
  _findFunctionPathAndHandler(functionHandler: string): { handler: string; filePath: string } {
    const dir = path.dirname(functionHandler);
    const handler = path.basename(functionHandler);
    const splitHandler = handler.split('.');
    const filePath = `${dir}/${splitHandler[0]}.js`;
    const handlerName = `${splitHandler[1]}`;

    return { handler: handlerName, filePath };
  }

  buildStepWorkFlow(): Promise<void | Callback> {
    this.cliLog('Building StepWorkFlow');
    if (!this.stateDefinition) throw new Error('Missing state definition');
    this.contextObject = this.createContextObject(this.stateDefinition.States);
    this.states = this.stateDefinition.States;

    return Promise.resolve().then(() => {
      if (!this.stateDefinition?.StartAt) {
        throw new Error('Missing `startAt` in definition');
      }
      // if (!this.loadedEventFile) throw new Error('Was unable to load event file');
      return this.process(
        this.states[this.stateDefinition.StartAt],
        this.stateDefinition.StartAt,
        this.loadedEventFile ?? {}
      );
    });
  }

  buildSubStepWorkFlow(stateDefinition: StateMachine['definition'], event: Event): Promise<any> {
    this.cliLog('Building Iterator StepWorkFlow');
    this.subContextObject = this.createContextObject(stateDefinition.States);
    this.subStates = stateDefinition.States;

    return Promise.resolve()
      .then(
        () => this.subStates && this.process(this.subStates[stateDefinition.StartAt], stateDefinition.StartAt, event)
      )
      .catch(err => {
        throw err;
      });
  }

  process(state: StateDefinition, stateName: string, event: Event): void | Promise<void> | Callback {
    if (state && state.Type === 'Parallel') {
      this.eventForParallelExecution = event;
    }
    const data = this._findStep(state, stateName);

    // if (data instanceof Promise) return Promise.resolve();
    if (!data || data instanceof Promise) {
      if ((!state || state.Type !== 'Parallel') && !this.mapResults) {
        this.cliLog('Serverless step function offline: Finished');
      }
      return Promise.resolve();
    }
    if (stateIsChoiceConditional(data) && data.choice) {
      return this._runChoice(data, event);
    } else if (!stateIsChoiceConditional(data)) {
      return this._run(data.f(event), event);
    }
  }

  _findStep(currentState: StateDefinition, currentStateName: string): StateValueReturn {
    // it means end of states
    if (!currentState) {
      this.currentState = null;
      this.currentStateName = null;
      return;
    }
    this.currentState = currentState;
    this.currentStateName = currentStateName;
    return this._states(currentState, currentStateName);
  }

  _run(func: Callback | Promise<void>, event: Event): void | Promise<void> | Callback {
    if (!func) return; // end of states
    this.executionLog(`~~~~~~~~~~~~~~~~~~~~~~~~~~~ ${this.currentStateName} started ~~~~~~~~~~~~~~~~~~~~~~~~~~~`);

    const contextObject = this.subContextObject || this.contextObject;
    if (contextObject) {
      if (func instanceof Promise) {
        return func;
      }
      return func(event, contextObject, contextObject.done);
    }
  }

  _states(currentState: StateDefinition, currentStateName: string): StateValueReturn {
    switch (currentState.Type) {
      case 'Map':
        return {
          f: (event: Event): Promise<void> => {
            const items = _.get(event, currentState.ItemsPath?.replace(/^\$\./, '') ?? '', []);
            const mapItems: unknown[] = _.clone(items);
            this.mapResults = [];

            const processNextItem = (): Promise<void> => {
              const item = mapItems.shift();

              if (item) {
                const parseValue = (value: string) => {
                  if (value === '$$.Map.Item.Value') {
                    return item;
                  }

                  if (/^\$\./.test(value)) {
                    return _.get(event, value.replace(/^\$\./, ''));
                  }
                };

                const params = currentState.Parameters
                  ? Object.keys(currentState.Parameters).reduce((acc: { [key: string]: unknown }, key) => {
                      if (/\.\$$/.test(key) && currentState.Parameters) {
                        acc[key.replace(/\.\$$/, '')] = parseValue(currentState.Parameters[key].toString());
                      }

                      return acc;
                    }, {})
                  : {};

                if (currentState?.Iterator) {
                  return this.buildSubStepWorkFlow(currentState.Iterator, params).then(() => processNextItem());
                }
              }

              return Promise.resolve();
            };

            return processNextItem().then(() => {
              this.subContextObject = null;
              this.subStates = {};

              if (currentState.ResultPath) {
                _.set(event, currentState.ResultPath.replace(/\$\./, ''), this.mapResults);
              }

              this.mapResults = [];

              if (currentState.Next) {
                this.process(this.states[currentState.Next], currentState.Next, event);
              }
              return Promise.resolve();
            });
          },
        };

      case 'Task': // just push task to general array
        //before each task restore global default env variables
        process.env = Object.assign({}, this.environmentVariables);
        const functionName = this.variables?.[currentStateName];
        const f = functionName ? this.functions[functionName] : null;
        if (f === undefined || f === null) {
          this.cliLog(`Function "${currentStateName}" does not presented in serverless manifest`);
          throw new Error(`Function "${currentStateName}" does not presented in serverless manifest`);
        }
        if (!definitionIsHandler(f)) return;
        const { handler, filePath } = this._findFunctionPathAndHandler(f.handler);
        // if function has additional variables - attach it to function
        if (f.environment) {
          process.env = _.extend(process.env, f.environment);
        }
        return {
          name: currentStateName,
          f: () => import(path.join(this.location, filePath))[handler],
        };
      case 'Parallel': // look through branches and push all of them
        this.eventParallelResult = [];
        _.forEach(currentState.Branches, branch => {
          this.parallelBranch = branch;
          return this.eventForParallelExecution
            ? this.process(branch.States[branch.StartAt], branch.StartAt, this.eventForParallelExecution)
            : null;
        });
        if (currentState.Next) {
          this.process(this.states[currentState.Next], currentState.Next, this.eventParallelResult);
        }
        delete this.parallelBranch;
        this.eventParallelResult = [];
        return;
      case 'Choice':
        //push all choices. but need to store information like
        // 1) on which variable need to look: ${variable}
        // 2) find operator: ${condition}
        // 3) find function which will check data: ${checkFunction}
        // 4) value which we will use in order to compare data: ${compareWithValue}
        // 5) find target function - will be used if condition true: ${f}
        const choiceConditional: ChoiceConditional = {
          choice: [],
        };
        _.forEach(currentState.Choices, choice => {
          const variable = choice.Variable?.split('$.')[1];
          const condition = _.pick(choice, enumList.supportedComparisonOperator);
          if (!condition) {
            this.cliLog(`Sorry! At this moment we don't support operator '${choice}'`);
            process.exit(1);
          }
          const operator = Object.keys(condition)[0];
          const checkFunction = enumList.convertOperator[operator];
          const compareWithValue = condition[operator];

          if (variable) {
            const choiceObj: ChoiceInstance = {
              variable,
              condition,
              checkFunction,
              compareWithValue,
              choiceFunction: choice.Next,
            };
            choiceConditional.choice.push(choiceObj);
          }
        });
        // if exists default function - store it
        if (currentState.Default) {
          choiceConditional.defaultFunction = currentState.Default;
        }
        return choiceConditional;
      case 'Wait':
        // Wait State
        // works with parameter: seconds, timestamp, timestampPath, secondsPath;
        return {
          waitState: true,
          f: event => {
            const waitTimer = this._waitState(event, currentState, currentStateName);
            this.cliLog(`Wait function ${currentStateName} - please wait ${waitTimer} seconds`);
            return (arg1, arg2, cb) => {
              setTimeout(() => {
                cb(null, event);
              }, waitTimer * 1000);
            };
          },
        };
      case 'Pass':
        return {
          f: event => {
            return (arg1, arg2, cb) => {
              this.cliLog('!!! Pass State !!!');
              const eventResult = this._passStateFields(currentState, event);
              cb(null, eventResult);
            };
          },
        };

      case 'Succeed':
        this.cliLog('Succeed');
        return Promise.resolve('Succeed');
      case 'Fail':
        const obj: Failure = {};
        if (currentState.Cause) obj.Cause = currentState.Cause;
        if (currentState.Error) obj.Error = currentState.Error;
        this.cliLog('Fail');
        if (!_.isEmpty(obj)) {
          this.cliLog(JSON.stringify(obj));
        }
        return Promise.resolve('Fail');
    }
    return;
  }

  _passStateFields(currentState: StateDefinition, event: Event): Event {
    if (!currentState.ResultPath) {
      return currentState.Result || event;
    } else {
      const variableName = currentState.ResultPath.split('$.')[1];
      if (!currentState.Result) {
        event[variableName] = event;
        return event;
      }
      event[variableName] = currentState.Result;
      return event;
    }
  }

  _runChoice(data: ChoiceConditional, result: Event): void | Promise<void> | Callback {
    let existsAnyMatches = false;
    if (!data?.choice) return;

    //look through choice and find appropriate
    _.forEach(data.choice, choice => {
      //check if result from previous function has of value which described in Choice
      const functionResultValue = _.get(result, choice.variable);
      if (!_.isNil(functionResultValue)) {
        //check condition
        const isConditionTrue = choice.checkFunction(functionResultValue, choice.compareWithValue);
        if (isConditionTrue && choice.choiceFunction) {
          existsAnyMatches = true;
          return this.process(this.states[choice.choiceFunction], choice.choiceFunction, result);
        }
      }
    });
    if (!existsAnyMatches && data.defaultFunction) {
      const fName = data.defaultFunction;
      return this.process(this.states[fName], fName, result);
    }
  }

  _waitState(event: Event, currentState: StateDefinition, currentStateName: string): number {
    let waitTimer = 0,
      targetTime,
      timeDiff;
    const currentTime = moment();
    const waitListKeys = ['Seconds', 'Timestamp', 'TimestampPath', 'SecondsPath'];
    const waitField = _.omit(currentState, 'Type', 'Next', 'Result');
    const waitKey = Object.keys(waitField)[0];
    if (!waitListKeys.includes(waitKey)) {
      const error = `Plugin does not support wait operator "${waitKey}"`;
      throw new this.serverless.classes.Error(error);
    }
    switch (Object.keys(waitField)[0]) {
      case 'Seconds':
        waitTimer = waitField['Seconds'];
        break;
      case 'Timestamp':
        targetTime = moment(waitField['Timestamp']);
        timeDiff = targetTime.diff(currentTime, 'seconds');
        if (timeDiff > 0) waitTimer = timeDiff;
        break;
      case 'TimestampPath':
        const timestampPath = waitField['TimestampPath'].split('$.')[1];
        if (event[timestampPath] === undefined) {
          const error = `An error occurred while executing the state ${currentStateName}.
                     The TimestampPath parameter does not reference an input value: ${waitField['TimestampPath']}`;
          throw new this.serverless.classes.Error(error);
        }
        targetTime = moment(event[timestampPath]);
        timeDiff = targetTime.diff(currentTime, 'seconds');
        if (timeDiff > 0) waitTimer = timeDiff;
        break;
      case 'SecondsPath':
        const secondsPath = waitField['SecondsPath'].split('$.')[1];
        const waitSeconds = event[secondsPath];
        if (waitSeconds === undefined) {
          const error = `
                    An error occurred while executing the state ${currentStateName}.
                    The SecondsPath parameter does not reference an input value: ${waitField['SecondsPath']}`;
          throw new this.serverless.classes.Error(error);
        }
        waitTimer = waitSeconds;
        break;
    }
    return waitTimer;
  }

  createContextObject(states: StateMachine['definition']['States']): ContextObject {
    const cb = (err: Error | undefined | null, result?: Event) => {
      // return new Promise((resolve, reject) => {
      if (err) {
        throw `Error in function "${this.currentStateName}": ${JSON.stringify(err)}`;
      }
      this.executionLog(`~~~~~~~~~~~~~~~~~~~~~~~~~~~ ${this.currentStateName} finished ~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
      let state = states;
      if (this.parallelBranch && this.parallelBranch.States) {
        state = this.parallelBranch.States;
        if (!this.currentState?.Next) this.eventParallelResult.push(result ?? {}); // it means the end of execution of branch
      }

      if (this.mapResults && !this.currentState?.Next) {
        this.mapResults.push(result);
      }
      if (this.currentState?.Next) {
        this.process(state[this.currentState.Next], this.currentState.Next, result ?? {});
      }
      // return resolve();
      // });
    };

    return {
      cb,
      done: cb,
      succeed: result => cb(null, result),
      fail: (err: Error) => cb(err),
    };
  }

  executionLog(log: string): void {
    if (this.detailedLog) this.cliLog(log);
  }
}