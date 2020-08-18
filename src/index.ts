// tslint:disable-next-line: no-var-requires
require("dotenv").config();

// TODO: remove in v11
if ("DISABLE_STATS" in process.env) {
  // tslint:disable:no-console
  console.warn('[probot] "DISABLE_STATS" is no longer used since v10');
}
if ("IGNORED_ACCOUNTS" in process.env) {
  // tslint:disable:no-console
  console.warn('[probot] "IGNORED_ACCOUNTS" is no longer used since v10');
}

import { WebhookEvent, Webhooks } from "@octokit/webhooks";
import Logger from "bunyan";
import express from "express";
import Redis from "ioredis";
import LRUCache from "lru-cache";
import { Deprecation } from "deprecation";

import { Server } from "http";
import { Application } from "./application";
import { setupApp } from "./apps/setup";
import { Context } from "./context";
import { ProbotOctokit, ProbotOctokitCore } from "./github/octokit";
import { logger } from "./logger";
import { logRequestErrors } from "./middleware/log-request-errors";
import { findPrivateKey } from "./private-key";
import { resolve } from "./resolver";
import { createServer } from "./server";
import { createWebhookProxy } from "./webhook-proxy";
import { errorHandler } from "./error-handler";
import { ProbotWebhooks, State } from "./types";
import { webhookTransform } from "./webhook-transform";
import { wrapLogger } from "./wrap-logger";
import { getThrottleOptions } from "./get-throttle-options";
import { getProbotOctokitWithDefaults } from "./get-probot-octokit-with-defaults";

export interface Options {
  // same options as Application class
  privateKey?: string;
  githubToken?: string;
  id?: number;
  Octokit?: typeof ProbotOctokit;
  redisConfig?: Redis.RedisOptions;
  secret?: string;
  webhookPath?: string;

  // Probot class-specific options
  /**
   * @deprecated `cert` options is deprecated. Use `privateKey` instead
   */
  cert?: string;
  port?: number;
  webhookProxy?: string;
}

// tslint:disable:no-var-requires
const defaultAppFns: ApplicationFunction[] = [
  require("./apps/default"),
  require("./apps/sentry"),
];
// tslint:enable:no-var-requires

export class Probot {
  public static async run(appFn: ApplicationFunction | string[]) {
    const pkgConf = require("pkg-conf");
    const program = require("commander");

    const readOptions = (): Options => {
      if (Array.isArray(appFn)) {
        program
          .usage("[options] <apps...>")
          .option(
            "-p, --port <n>",
            "Port to start the server on",
            process.env.PORT || 3000
          )
          .option(
            "-W, --webhook-proxy <url>",
            "URL of the webhook proxy service.`",
            process.env.WEBHOOK_PROXY_URL
          )
          .option(
            "-w, --webhook-path <path>",
            "URL path which receives webhooks. Ex: `/webhook`",
            process.env.WEBHOOK_PATH
          )
          .option("-a, --app <id>", "ID of the GitHub App", process.env.APP_ID)
          .option(
            "-s, --secret <secret>",
            "Webhook secret of the GitHub App",
            process.env.WEBHOOK_SECRET
          )
          .option(
            "-P, --private-key <file>",
            "Path to certificate of the GitHub App",
            process.env.PRIVATE_KEY_PATH
          )
          .parse(appFn);

        return {
          privateKey: findPrivateKey(program.privateKey) || undefined,
          id: program.app,
          port: program.port,
          secret: program.secret,
          webhookPath: program.webhookPath,
          webhookProxy: program.webhookProxy,
        };
      }
      const privateKey = findPrivateKey();
      return {
        privateKey: (privateKey && privateKey.toString()) || undefined,
        id: Number(process.env.APP_ID),
        port: Number(process.env.PORT) || 3000,
        secret: process.env.WEBHOOK_SECRET,
        webhookPath: process.env.WEBHOOK_PATH,
        webhookProxy: process.env.WEBHOOK_PROXY_URL,
      };
    };

    const options = readOptions();
    const probot = new Probot(options);

    if (!options.id || !options.privateKey) {
      if (process.env.NODE_ENV === "production") {
        if (!options.id) {
          throw new Error(
            "Application ID is missing, and is required to run in production mode. " +
              "To resolve, ensure the APP_ID environment variable is set."
          );
        } else if (!options.privateKey) {
          throw new Error(
            "Certificate is missing, and is required to run in production mode. " +
              "To resolve, ensure either the PRIVATE_KEY or PRIVATE_KEY_PATH environment variable is set and contains a valid certificate"
          );
        }
      }
      probot.load(setupApp);
    } else if (Array.isArray(appFn)) {
      const pkg = await pkgConf("probot");
      probot.setup(program.args.concat(pkg.apps || pkg.plugins || []));
    } else {
      probot.load(appFn);
    }
    probot.start();

    return probot;
  }

  public server: express.Application;
  public webhooks: ProbotWebhooks;
  public logger: Logger;

  // These 3 need to be public for the tests to work.
  public options: Options;
  public throttleOptions: any;

  private httpServer?: Server;
  private apps: Application[];
  private state: State;

  constructor(options: Options) {
    if (process.env.GHE_HOST && /^https?:\/\//.test(process.env.GHE_HOST)) {
      throw new Error(
        "Your `GHE_HOST` environment variable should not begin with https:// or http://"
      );
    }

    if (options.cert) {
      console.warn(
        new Deprecation(
          `[probot] "cert" option is deprecated. Use "privateKey" instead`
        )
      );
      options.privateKey = options.cert;
    }

    //
    // Probot class-specific options (Express server & Webhooks)
    //
    options.webhookPath = options.webhookPath || "/";
    options.secret = options.secret || "development";

    // TODO: deprecate probot.logger in favor of probot.log.
    //       Use `this.log = wrapLogger(logger)` like in application.ts
    this.logger = logger;
    this.apps = [];

    // TODO: Why is this public?
    this.options = options;

    // TODO: support redis backend for access token cache if `options.redisConfig || process.env.REDIS_URL`
    const cache = new LRUCache<number, string>({
      // cache max. 15000 tokens, that will use less than 10mb memory
      max: 15000,
      // Cache for 1 minute less than GitHub expiry
      maxAge: Number(process.env.INSTALLATION_TOKEN_TTL) || 1000 * 60 * 59,
    });

    const Octokit = getProbotOctokitWithDefaults({
      githubToken: options.githubToken,
      Octokit: options.Octokit || ProbotOctokit,
      appId: options.id,
      privateKey: options.privateKey,
      cache,
    });
    const octokit = new Octokit();

    const log = wrapLogger(logger);
    this.throttleOptions = getThrottleOptions({
      log,
      redisConfig: options.redisConfig,
    });

    this.state = {
      cache,
      githubToken: options.githubToken,
      log,
      Octokit,
      octokit,
      throttleOptions: this.throttleOptions,
    };

    this.webhooks = new Webhooks({
      path: options.webhookPath,
      secret: options.secret,
      transform: webhookTransform.bind(null, this.state),
    });
    // TODO: normalize error handler with code in application.ts
    this.webhooks.on("error", errorHandler);

    this.server = createServer({
      webhook: (this.webhooks as any).middleware,
      logger,
    });
  }

  /**
   * @deprecated `probot.webhook` is deprecated. Use `probot.webhooks` instead
   */
  public get webhook(): Webhooks {
    console.warn(
      new Deprecation(
        `[probot] "probot.webhook" is deprecated. Use "probot.webhooks" instead instead`
      )
    );

    return this.webhooks;
  }

  public receive(event: WebhookEvent) {
    this.logger.debug({ event }, "Webhook received");
    return Promise.all(this.apps.map((app) => app.receive(event)));
  }

  public load(appFn: string | ApplicationFunction) {
    if (typeof appFn === "string") {
      appFn = resolve(appFn) as ApplicationFunction;
    }

    const app = new Application({
      cache: this.state.cache,
      githubToken: this.state.githubToken,
      Octokit: this.state.Octokit,
      octokit: this.state.octokit,
      throttleOptions: this.throttleOptions,
      webhooks: this.webhooks,
    });

    // Connect the router from the app to the server
    this.server.use(app.router);

    // Initialize the ApplicationFunction
    app.load(appFn);
    this.apps.push(app);

    return app;
  }

  public setup(appFns: Array<string | ApplicationFunction>) {
    // Log all unhandled rejections
    (process as NodeJS.EventEmitter).on("unhandledRejection", errorHandler);

    // Load the given appFns along with the default ones
    appFns.concat(defaultAppFns).forEach((appFn) => this.load(appFn));

    // Register error handler as the last middleware
    this.server.use(logRequestErrors);
  }

  public start() {
    this.httpServer = this.server
      .listen(this.options.port, () => {
        if (this.options.webhookProxy) {
          createWebhookProxy({
            logger,
            path: this.options.webhookPath,
            port: this.options.port,
            url: this.options.webhookProxy,
          });
        }
        logger.info("Listening on http://localhost:" + this.options.port);
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          logger.error(
            `Port ${this.options.port} is already in use. You can define the PORT environment variable to use a different port.`
          );
        } else {
          logger.error(err);
        }
        process.exit(1);
      });

    return this.httpServer;
  }

  public stop() {
    if (!this.httpServer) return;

    this.httpServer.close();
  }
}

export const createProbot = (options: Options) => {
  console.warn(
    new Deprecation(
      `[probot] "createProbot(options)" is deprecated, use "new Probot(options)" instead`
    )
  );
  return new Probot(options);
};

export type ApplicationFunction = (app: Application) => void;

export { Logger, Context, Application, ProbotOctokit, ProbotOctokitCore };
