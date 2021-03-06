/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import moment from 'moment';
import { loggingSystemMock } from 'src/core/server/mocks';
import { getResult, getMlResult } from '../routes/__mocks__/request_responses';
import { signalRulesAlertType } from './signal_rule_alert_type';
import { alertsMock, AlertServicesMock } from '../../../../../alerts/server/mocks';
import { ruleStatusServiceFactory } from './rule_status_service';
import { getListsClient, getExceptions, sortExceptionItems, checkPrivileges } from './utils';
import { parseScheduleDates } from '../../../../common/detection_engine/parse_schedule_dates';
import { RuleExecutorOptions, SearchAfterAndBulkCreateReturnType } from './types';
import { searchAfterAndBulkCreate } from './search_after_bulk_create';
import { scheduleNotificationActions } from '../notifications/schedule_notification_actions';
import { RuleAlertType } from '../rules/types';
import { findMlSignals } from './find_ml_signals';
import { bulkCreateMlSignals } from './bulk_create_ml_signals';
import { listMock } from '../../../../../lists/server/mocks';
import { getListClientMock } from '../../../../../lists/server/services/lists/list_client.mock';
import { getExceptionListClientMock } from '../../../../../lists/server/services/exception_lists/exception_list_client.mock';
import { getExceptionListItemSchemaMock } from '../../../../../lists/common/schemas/response/exception_list_item_schema.mock';
import { ApiResponse } from '@elastic/elasticsearch/lib/Transport';

jest.mock('./rule_status_saved_objects_client');
jest.mock('./rule_status_service');
jest.mock('./search_after_bulk_create');
jest.mock('./get_filter');
jest.mock('./utils', () => {
  const original = jest.requireActual('./utils');
  return {
    ...original,
    getListsClient: jest.fn(),
    getExceptions: jest.fn(),
    sortExceptionItems: jest.fn(),
    checkPrivileges: jest.fn(),
  };
});
jest.mock('../notifications/schedule_notification_actions');
jest.mock('./find_ml_signals');
jest.mock('./bulk_create_ml_signals');
jest.mock('../../../../common/detection_engine/parse_schedule_dates');

const getPayload = (
  ruleAlert: RuleAlertType,
  services: AlertServicesMock
): RuleExecutorOptions => ({
  alertId: ruleAlert.id,
  services,
  params: {
    ...ruleAlert.params,
    actions: [],
    enabled: ruleAlert.enabled,
    interval: ruleAlert.schedule.interval,
    name: ruleAlert.name,
    tags: ruleAlert.tags,
    throttle: ruleAlert.throttle,
  },
  state: {},
  spaceId: '',
  name: 'name',
  tags: [],
  startedAt: new Date('2019-12-13T16:50:33.400Z'),
  previousStartedAt: new Date('2019-12-13T16:40:33.400Z'),
  createdBy: 'elastic',
  updatedBy: 'elastic',
});

describe('rules_notification_alert_type', () => {
  const version = '8.0.0';
  const jobsSummaryMock = jest.fn();
  const mlMock = {
    mlClient: {
      callAsInternalUser: jest.fn(),
      close: jest.fn(),
      asScoped: jest.fn(),
    },
    jobServiceProvider: jest.fn().mockReturnValue({
      jobsSummary: jobsSummaryMock,
    }),
    anomalyDetectorsProvider: jest.fn(),
    mlSystemProvider: jest.fn(),
    modulesProvider: jest.fn(),
    resultsServiceProvider: jest.fn(),
    alertingServiceProvider: jest.fn(),
  };
  let payload: jest.Mocked<RuleExecutorOptions>;
  let alert: ReturnType<typeof signalRulesAlertType>;
  let logger: ReturnType<typeof loggingSystemMock.createLogger>;
  let alertServices: AlertServicesMock;
  let ruleStatusService: Record<string, jest.Mock>;

  beforeEach(() => {
    alertServices = alertsMock.createAlertServices();
    logger = loggingSystemMock.createLogger();
    ruleStatusService = {
      success: jest.fn(),
      find: jest.fn(),
      goingToRun: jest.fn(),
      error: jest.fn(),
      warning: jest.fn(),
    };
    (ruleStatusServiceFactory as jest.Mock).mockReturnValue(ruleStatusService);
    (getListsClient as jest.Mock).mockReturnValue({
      listClient: getListClientMock(),
      exceptionsClient: getExceptionListClientMock(),
    });
    (getExceptions as jest.Mock).mockReturnValue([getExceptionListItemSchemaMock()]);
    (sortExceptionItems as jest.Mock).mockReturnValue({
      exceptionsWithoutValueLists: [getExceptionListItemSchemaMock()],
      exceptionsWithValueLists: [],
    });
    (searchAfterAndBulkCreate as jest.Mock).mockClear();
    (searchAfterAndBulkCreate as jest.Mock).mockResolvedValue({
      success: true,
      searchAfterTimes: [],
      createdSignalsCount: 10,
    });
    (checkPrivileges as jest.Mock).mockImplementation(async (_, indices) => {
      return {
        index: indices.reduce(
          (acc: { index: { [x: string]: { read: boolean } } }, index: string) => {
            return {
              [index]: {
                read: true,
              },
              ...acc,
            };
          },
          {}
        ),
      };
    });
    alertServices.callCluster.mockResolvedValue({
      hits: {
        total: { value: 10 },
      },
    });
    const value: Partial<ApiResponse> = {
      statusCode: 200,
      body: {
        indices: ['index1', 'index2', 'index3', 'index4'],
        fields: {
          '@timestamp': {
            date: {
              indices: ['index1', 'index2', 'index3', 'index4'],
              searchable: true,
              aggregatable: false,
            },
          },
        },
      },
    };
    alertServices.scopedClusterClient.fieldCaps.mockResolvedValue(value as ApiResponse);
    const ruleAlert = getResult();
    alertServices.savedObjectsClient.get.mockResolvedValue({
      id: 'id',
      type: 'type',
      references: [],
      attributes: ruleAlert,
    });

    payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;

    alert = signalRulesAlertType({
      logger,
      eventsTelemetry: undefined,
      version,
      ml: mlMock,
      lists: listMock.createSetup(),
    });
  });

  describe('executor', () => {
    it('should warn about the gap between runs if gap is very large', async () => {
      payload.previousStartedAt = moment().subtract(100, 'm').toDate();
      await alert.executor(payload);
      expect(logger.warn).toHaveBeenCalled();
      expect(ruleStatusService.error).toHaveBeenCalled();
      expect(ruleStatusService.error.mock.calls[0][1]).toEqual({
        gap: 'an hour',
      });
    });

    it('should set a warning for when rules cannot read ALL provided indices', async () => {
      (checkPrivileges as jest.Mock).mockResolvedValueOnce({
        username: 'elastic',
        has_all_requested: false,
        cluster: {},
        index: {
          'myfa*': {
            read: true,
          },
          'anotherindex*': {
            read: true,
          },
          'some*': {
            read: false,
          },
        },
        application: {},
      });
      payload.params.index = ['some*', 'myfa*', 'anotherindex*'];
      await alert.executor(payload);
      expect(ruleStatusService.warning).toHaveBeenCalled();
      expect(ruleStatusService.warning.mock.calls[0][0]).toContain(
        'Missing required read privileges on the following indices: ["some*"]'
      );
    });

    it('should set a failure status for when rules cannot read ANY provided indices', async () => {
      (checkPrivileges as jest.Mock).mockResolvedValueOnce({
        username: 'elastic',
        has_all_requested: false,
        cluster: {},
        index: {
          'myfa*': {
            read: false,
          },
          'some*': {
            read: false,
          },
        },
        application: {},
      });
      payload.params.index = ['some*', 'myfa*'];
      await alert.executor(payload);
      expect(ruleStatusService.warning).toHaveBeenCalled();
      expect(ruleStatusService.warning.mock.calls[0][0]).toContain(
        'This rule may not have the required read privileges to the following indices: ["myfa*","some*"]'
      );
    });

    it('should NOT warn about the gap between runs if gap small', async () => {
      payload.previousStartedAt = moment().subtract(10, 'm').toDate();
      await alert.executor(payload);
      expect(logger.warn).toHaveBeenCalledTimes(0);
      expect(ruleStatusService.error).toHaveBeenCalledTimes(0);
    });

    it("should set refresh to 'wait_for' when actions are present", async () => {
      const ruleAlert = getResult();
      ruleAlert.actions = [
        {
          actionTypeId: '.slack',
          params: {
            message:
              'Rule generated {{state.signals_count}} signals\n\n{{context.rule.name}}\n{{{context.results_link}}}',
          },
          group: 'default',
          id: '99403909-ca9b-49ba-9d7a-7e5320e68d05',
        },
      ];

      alertServices.savedObjectsClient.get.mockResolvedValue({
        id: 'id',
        type: 'type',
        references: [],
        attributes: ruleAlert,
      });
      await alert.executor(payload);
      expect((searchAfterAndBulkCreate as jest.Mock).mock.calls[0][0].refresh).toEqual('wait_for');
      (searchAfterAndBulkCreate as jest.Mock).mockClear();
    });

    it('should set refresh to false when actions are not present', async () => {
      await alert.executor(payload);
      expect((searchAfterAndBulkCreate as jest.Mock).mock.calls[0][0].refresh).toEqual(false);
      (searchAfterAndBulkCreate as jest.Mock).mockClear();
    });

    it('should call scheduleActions if signalsCount was greater than 0 and rule has actions defined', async () => {
      const ruleAlert = getResult();
      ruleAlert.actions = [
        {
          actionTypeId: '.slack',
          params: {
            message:
              'Rule generated {{state.signals_count}} signals\n\n{{context.rule.name}}\n{{{context.results_link}}}',
          },
          group: 'default',
          id: '99403909-ca9b-49ba-9d7a-7e5320e68d05',
        },
      ];

      alertServices.savedObjectsClient.get.mockResolvedValue({
        id: 'id',
        type: 'type',
        references: [],
        attributes: ruleAlert,
      });

      await alert.executor(payload);

      expect(scheduleNotificationActions).toHaveBeenCalledWith(
        expect.objectContaining({
          signalsCount: 10,
        })
      );
    });

    it('should resolve results_link when meta is an empty object to use "/app/security"', async () => {
      const ruleAlert = getResult();
      ruleAlert.params.meta = {};
      ruleAlert.actions = [
        {
          actionTypeId: '.slack',
          params: {
            message:
              'Rule generated {{state.signals_count}} signals\n\n{{context.rule.name}}\n{{{context.results_link}}}',
          },
          group: 'default',
          id: '99403909-ca9b-49ba-9d7a-7e5320e68d05',
        },
      ];

      alertServices.savedObjectsClient.get.mockResolvedValue({
        id: 'rule-id',
        type: 'type',
        references: [],
        attributes: ruleAlert,
      });
      (parseScheduleDates as jest.Mock).mockReturnValue(moment(100));
      payload.params.meta = {};
      await alert.executor(payload);

      expect(scheduleNotificationActions).toHaveBeenCalledWith(
        expect.objectContaining({
          resultsLink:
            '/app/security/detections/rules/id/rule-id?timerange=(global:(linkTo:!(timeline),timerange:(from:100,kind:absolute,to:100)),timeline:(linkTo:!(global),timerange:(from:100,kind:absolute,to:100)))',
        })
      );
    });

    it('should resolve results_link when meta is undefined use "/app/security"', async () => {
      const ruleAlert = getResult();
      delete ruleAlert.params.meta;
      ruleAlert.actions = [
        {
          actionTypeId: '.slack',
          params: {
            message:
              'Rule generated {{state.signals_count}} signals\n\n{{context.rule.name}}\n{{{context.results_link}}}',
          },
          group: 'default',
          id: '99403909-ca9b-49ba-9d7a-7e5320e68d05',
        },
      ];

      alertServices.savedObjectsClient.get.mockResolvedValue({
        id: 'rule-id',
        type: 'type',
        references: [],
        attributes: ruleAlert,
      });
      (parseScheduleDates as jest.Mock).mockReturnValue(moment(100));
      delete payload.params.meta;
      await alert.executor(payload);

      expect(scheduleNotificationActions).toHaveBeenCalledWith(
        expect.objectContaining({
          resultsLink:
            '/app/security/detections/rules/id/rule-id?timerange=(global:(linkTo:!(timeline),timerange:(from:100,kind:absolute,to:100)),timeline:(linkTo:!(global),timerange:(from:100,kind:absolute,to:100)))',
        })
      );
    });

    it('should resolve results_link with a custom link', async () => {
      const ruleAlert = getResult();
      ruleAlert.params.meta = { kibana_siem_app_url: 'http://localhost' };
      ruleAlert.actions = [
        {
          actionTypeId: '.slack',
          params: {
            message:
              'Rule generated {{state.signals_count}} signals\n\n{{context.rule.name}}\n{{{context.results_link}}}',
          },
          group: 'default',
          id: '99403909-ca9b-49ba-9d7a-7e5320e68d05',
        },
      ];

      alertServices.savedObjectsClient.get.mockResolvedValue({
        id: 'rule-id',
        type: 'type',
        references: [],
        attributes: ruleAlert,
      });
      (parseScheduleDates as jest.Mock).mockReturnValue(moment(100));
      payload.params.meta = { kibana_siem_app_url: 'http://localhost' };
      await alert.executor(payload);

      expect(scheduleNotificationActions).toHaveBeenCalledWith(
        expect.objectContaining({
          resultsLink:
            'http://localhost/detections/rules/id/rule-id?timerange=(global:(linkTo:!(timeline),timerange:(from:100,kind:absolute,to:100)),timeline:(linkTo:!(global),timerange:(from:100,kind:absolute,to:100)))',
        })
      );
    });

    describe('ML rule', () => {
      it('should throw an error if ML plugin was not available', async () => {
        const ruleAlert = getMlResult();
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        alert = signalRulesAlertType({
          logger,
          eventsTelemetry: undefined,
          version,
          ml: undefined,
          lists: undefined,
        });
        await alert.executor(payload);
        expect(logger.error).toHaveBeenCalled();
        expect(logger.error.mock.calls[0][0]).toContain(
          'ML plugin unavailable during rule execution'
        );
      });

      it('should throw an error if machineLearningJobId or anomalyThreshold was not null', async () => {
        const ruleAlert = getMlResult();
        ruleAlert.params.anomalyThreshold = undefined;
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        payload.previousStartedAt = null;
        await alert.executor(payload);
        expect(logger.error).toHaveBeenCalled();
        expect(logger.error.mock.calls[0][0]).toContain(
          'Machine learning rule is missing job id and/or anomaly threshold'
        );
      });

      it('should throw an error if Machine learning job summary was null', async () => {
        const ruleAlert = getMlResult();
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        payload.previousStartedAt = null;
        jobsSummaryMock.mockResolvedValue([]);
        await alert.executor(payload);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.warn.mock.calls[0][0]).toContain('Machine learning job is not started');
        expect(ruleStatusService.error).toHaveBeenCalled();
        expect(ruleStatusService.error.mock.calls[0][0]).toContain(
          'Machine learning job is not started'
        );
      });

      it('should log an error if Machine learning job was not started', async () => {
        const ruleAlert = getMlResult();
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        payload.previousStartedAt = null;
        jobsSummaryMock.mockResolvedValue([
          {
            id: 'some_job_id',
            jobState: 'starting',
            datafeedState: 'started',
          },
        ]);
        (findMlSignals as jest.Mock).mockResolvedValue({
          _shards: {},
          hits: {
            hits: [],
          },
        });
        await alert.executor(payload);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.warn.mock.calls[0][0]).toContain('Machine learning job is not started');
        expect(ruleStatusService.error).toHaveBeenCalled();
        expect(ruleStatusService.error.mock.calls[0][0]).toContain(
          'Machine learning job is not started'
        );
      });

      it('should not call ruleStatusService.success if no anomalies were found', async () => {
        const ruleAlert = getMlResult();
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        jobsSummaryMock.mockResolvedValue([]);
        (findMlSignals as jest.Mock).mockResolvedValue({
          _shards: {},
          hits: {
            hits: [],
          },
        });
        (bulkCreateMlSignals as jest.Mock).mockResolvedValue({
          success: true,
          bulkCreateDuration: 0,
          createdItemsCount: 0,
          errors: [],
        });
        await alert.executor(payload);
        expect(ruleStatusService.success).not.toHaveBeenCalled();
      });

      it('should call ruleStatusService.success if signals were created', async () => {
        const ruleAlert = getMlResult();
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        payload.previousStartedAt = null;
        jobsSummaryMock.mockResolvedValue([
          {
            id: 'some_job_id',
            jobState: 'started',
            datafeedState: 'started',
          },
        ]);
        (findMlSignals as jest.Mock).mockResolvedValue({
          _shards: { failed: 0 },
          hits: {
            hits: [{}],
          },
        });
        (bulkCreateMlSignals as jest.Mock).mockResolvedValue({
          success: true,
          bulkCreateDuration: 1,
          createdItemsCount: 1,
          errors: [],
        });
        await alert.executor(payload);
        expect(ruleStatusService.success).toHaveBeenCalled();
      });

      it('should not call checkPrivileges if ML rule', async () => {
        const ruleAlert = getMlResult();
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        payload.previousStartedAt = null;
        jobsSummaryMock.mockResolvedValue([
          {
            id: 'some_job_id',
            jobState: 'started',
            datafeedState: 'started',
          },
        ]);
        (findMlSignals as jest.Mock).mockResolvedValue({
          _shards: { failed: 0 },
          hits: {
            hits: [{}],
          },
        });
        (bulkCreateMlSignals as jest.Mock).mockResolvedValue({
          success: true,
          bulkCreateDuration: 1,
          createdItemsCount: 1,
          errors: [],
        });
        (checkPrivileges as jest.Mock).mockClear();

        await alert.executor(payload);
        expect(checkPrivileges).toHaveBeenCalledTimes(0);
        expect(ruleStatusService.success).toHaveBeenCalled();
      });

      it('should call scheduleActions if signalsCount was greater than 0 and rule has actions defined', async () => {
        const ruleAlert = getMlResult();
        ruleAlert.actions = [
          {
            actionTypeId: '.slack',
            params: {
              message:
                'Rule generated {{state.signals_count}} signals\n\n{{context.rule.name}}\n{{{context.results_link}}}',
            },
            group: 'default',
            id: '99403909-ca9b-49ba-9d7a-7e5320e68d05',
          },
        ];
        payload = getPayload(ruleAlert, alertServices) as jest.Mocked<RuleExecutorOptions>;
        alertServices.savedObjectsClient.get.mockResolvedValue({
          id: 'id',
          type: 'type',
          references: [],
          attributes: ruleAlert,
        });
        jobsSummaryMock.mockResolvedValue([]);
        (findMlSignals as jest.Mock).mockResolvedValue({
          _shards: { failed: 0 },
          hits: {
            hits: [{}],
          },
        });
        (bulkCreateMlSignals as jest.Mock).mockResolvedValue({
          success: true,
          bulkCreateDuration: 1,
          createdItemsCount: 1,
          errors: [],
        });

        await alert.executor(payload);

        expect(scheduleNotificationActions).toHaveBeenCalledWith(
          expect.objectContaining({
            signalsCount: 1,
          })
        );
      });
    });

    describe('threat match', () => {
      it('should throw an error if threatQuery or threatIndex or threatMapping was not null', async () => {
        const result = getResult();
        result.params.type = 'threat_match';
        payload = getPayload(result, alertServices) as jest.Mocked<RuleExecutorOptions>;
        await alert.executor(payload);
        expect(logger.error).toHaveBeenCalled();
        expect(logger.error.mock.calls[0][0]).toContain(
          'An error occurred during rule execution: message: "Indicator match is missing threatQuery and/or threatIndex and/or threatMapping: threatQuery: "undefined" threatIndex: "undefined" threatMapping: "undefined"" name: "Detect Root/Admin Users" id: "04128c15-0d1b-4716-a4c5-46997ac7f3bd" rule id: "rule-1" signals index: ".siem-signals"'
        );
      });
    });
  });

  describe('should catch error', () => {
    it('when bulk indexing failed', async () => {
      const result: SearchAfterAndBulkCreateReturnType = {
        success: false,
        searchAfterTimes: [],
        bulkCreateTimes: [],
        lastLookBackDate: null,
        createdSignalsCount: 0,
        createdSignals: [],
        errors: ['Error that bubbled up.'],
      };
      (searchAfterAndBulkCreate as jest.Mock).mockResolvedValue(result);
      await alert.executor(payload);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.error.mock.calls[0][0]).toContain(
        'Bulk Indexing of signals failed: Error that bubbled up. name: "Detect Root/Admin Users" id: "04128c15-0d1b-4716-a4c5-46997ac7f3bd" rule id: "rule-1" signals index: ".siem-signals"'
      );
      expect(ruleStatusService.error).toHaveBeenCalled();
    });

    it('when error was thrown', async () => {
      (searchAfterAndBulkCreate as jest.Mock).mockRejectedValue({});
      await alert.executor(payload);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.error.mock.calls[0][0]).toContain('An error occurred during rule execution');
      expect(ruleStatusService.error).toHaveBeenCalled();
    });

    it('and call ruleStatusService with the default message', async () => {
      (searchAfterAndBulkCreate as jest.Mock).mockRejectedValue({});
      await alert.executor(payload);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.error.mock.calls[0][0]).toContain('An error occurred during rule execution');
      expect(ruleStatusService.error).toHaveBeenCalled();
    });
  });
});
