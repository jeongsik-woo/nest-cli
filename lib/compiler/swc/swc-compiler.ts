import * as chalk from 'chalk';
import { fork } from 'child_process';
import * as chokidar from 'chokidar';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Configuration } from '../../configuration';
import { ERROR_PREFIX } from '../../ui';
import { BaseCompiler } from '../base-compiler';
import { swcDefaultsFactory } from '../defaults/swc-defaults';
import { PluginMetadataGenerator } from '../plugins/plugin-metadata-generator';
import { PluginsLoader } from '../plugins/plugins-loader';
import {
  FOUND_NO_ISSUES_GENERATING_METADATA,
  FOUND_NO_ISSUES_METADATA_GENERATION_SKIPPED,
  SWC_LOG_PREFIX,
} from './constants';
import { TypeCheckerHost } from './type-checker-host';

export type SwcCompilerExtras = {
  watch: boolean;
  typeCheck: boolean;
};

export class SwcCompiler extends BaseCompiler {
  private readonly pluginMetadataGenerator = new PluginMetadataGenerator();
  private readonly typeCheckerHost = new TypeCheckerHost();

  constructor(pluginsLoader: PluginsLoader) {
    super(pluginsLoader);
  }

  public async run(
    configuration: Required<Configuration>,
    tsConfigPath: string,
    appName: string,
    extras: SwcCompilerExtras,
    onSuccess?: () => void,
  ) {
    const swcOptions = swcDefaultsFactory();
    if (extras.watch) {
      if (extras.typeCheck) {
        this.runTypeChecker(configuration, tsConfigPath, appName, extras);
      }
      await this.runSwc(swcOptions, extras);

      if (onSuccess) {
        onSuccess();

        const debounceTime = 150;
        const callback = this.debounce(onSuccess, debounceTime);
        this.watchFilesInOutDir(swcOptions, callback);
      }
    } else {
      if (extras.typeCheck) {
        await this.runTypeChecker(configuration, tsConfigPath, appName, extras);
      }
      await this.runSwc(swcOptions, extras);
      onSuccess?.();
    }
  }

  private runTypeChecker(
    configuration: Required<Configuration>,
    tsConfigPath: string,
    appName: string,
    extras: SwcCompilerExtras,
  ) {
    if (extras.watch) {
      const args = [
        tsConfigPath,
        appName,
        configuration.sourceRoot ?? 'src',
        JSON.stringify(configuration.compilerOptions.plugins ?? []),
      ];

      fork(join(__dirname, 'forked-type-checker.js'), args, {
        cwd: process.cwd(),
      });
    } else {
      const { readonlyVisitors } = this.loadPlugins(
        configuration,
        tsConfigPath,
        appName,
      );
      const outputDir = this.getPathToSource(
        configuration,
        tsConfigPath,
        appName,
      );

      let fulfilled = false;
      return new Promise<void>((resolve, reject) => {
        try {
          this.typeCheckerHost.run(tsConfigPath, {
            watch: extras.watch,
            onTypeCheck: (program) => {
              if (!fulfilled) {
                fulfilled = true;
                resolve();
              }
              if (readonlyVisitors.length > 0) {
                process.nextTick(() =>
                  console.log(FOUND_NO_ISSUES_GENERATING_METADATA),
                );

                this.pluginMetadataGenerator.generate({
                  outputDir,
                  visitors: readonlyVisitors,
                  tsProgramRef: program,
                });
              } else {
                process.nextTick(() =>
                  console.log(FOUND_NO_ISSUES_METADATA_GENERATION_SKIPPED),
                );
              }
            },
          });
        } catch (err) {
          if (!fulfilled) {
            fulfilled = true;
            reject(err);
          }
        }
      });
    }
  }

  private async runSwc(
    options: ReturnType<typeof swcDefaultsFactory>,
    extras: SwcCompilerExtras,
  ) {
    process.nextTick(() =>
      console.log(SWC_LOG_PREFIX, chalk.cyan('Running...')),
    );

    const swcCli = this.loadSwcCliBinary();
    const swcRcFile = await this.getSwcRcFileContentIfExists();
    const swcOptions = this.deepMerge(options.swcOptions, swcRcFile);

    await swcCli.default({
      ...options,
      swcOptions,
      cliOptions: {
        ...options.cliOptions,
        watch: extras.watch,
      },
    });
  }

  private loadSwcCliBinary() {
    try {
      return require('@swc/cli/lib/swc/dir');
    } catch (err) {
      console.error(
        ERROR_PREFIX +
          ' Failed to load "@swc/cli" and "@swc/core" packages. Please, install them by running "npm i -D @swc/cli @swc/core".',
      );
      throw err;
    }
  }

  private getSwcRcFileContentIfExists() {
    try {
      return JSON.parse(readFileSync(join(process.cwd(), '.swcrc'), 'utf8'));
    } catch (err) {
      return {};
    }
  }

  private deepMerge<T>(target: T, source: T): T {
    if (
      typeof target !== 'object' ||
      target === null ||
      typeof source !== 'object' ||
      source === null
    ) {
      return source;
    }

    const merged = { ...target };
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (key in target) {
          merged[key] = this.deepMerge(target[key], source[key]);
        } else {
          merged[key] = source[key];
        }
      }
    }
    return merged;
  }

  private debounce(callback: () => void, wait: number) {
    let timeout: NodeJS.Timeout;
    return () => {
      clearTimeout(timeout);
      timeout = setTimeout(callback, wait);
    };
  }

  private watchFilesInOutDir(
    options: ReturnType<typeof swcDefaultsFactory>,
    onChange: () => void,
  ) {
    const outDir = join(process.cwd(), options.cliOptions.outDir!, '**/*.js');
    const watcher = chokidar.watch(outDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });
    for (const type of ['add', 'change']) {
      watcher.on(type, async () => onChange());
    }
  }
}
