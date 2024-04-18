import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { DialogHelper } from '../../../helpers/dialogHelper';
import { Correlation } from '../../../models/content/correlation';
import { ContentItemStatus, RuleBaseItem } from '../../../models/content/ruleBaseItem';
import { ContentTreeProvider } from '../contentTreeProvider';
import { TestHelper } from '../../../helpers/testHelper';
import { SiemjManager } from '../../../models/siemj/siemjManager';
import { Configuration } from '../../../models/configuration';
import { RunIntegrationTestDialog } from '../../runIntegrationDialog';
import { SiemJOutputParser, SiemjExecutionResult } from '../../../models/siemj/siemJOutputParser';
import { CompilationType, IntegrationTestRunner, IntegrationTestRunnerOptions } from '../../../models/tests/integrationTestRunner';
import { ContentTreeBaseItem } from '../../../models/content/contentTreeBaseItem';
import { ExceptionHelper } from '../../../helpers/exceptionHelper';
import { Enrichment } from '../../../models/content/enrichment';
import { Log } from '../../../extension';
import { FileSystemHelper } from '../../../helpers/fileSystemHelper';
import { Normalization } from '../../../models/content/normalization';
import { TestStatus } from '../../../models/tests/testStatus';
import { BaseUnitTest } from '../../../models/tests/baseUnitTest';
import { ViewCommand } from './viewCommand';
import { XpException } from '../../../models/xpException';
import { OperationCanceledException } from '../../../models/operationCanceledException';
import { CancellationToken } from 'vscode-languageclient';
import { JsHelper } from '../../../helpers/jsHelper';

/**
 * Проверяет контент по требованиям. В настоящий момент реализована только проверка интеграционных тестов и локализаций.
 * TODO: учесть обновление дерева контента пользователем во время операции.
 * TODO: после обновления дерева статусы item-ам присваиваться не будут, нужно обновить список обрабатываемых рулей.
 */
export class ContentVerifierCommand extends ViewCommand {
	constructor(private readonly config: Configuration, private parentItem: ContentTreeBaseItem) {
		super();
	}

	async execute() : Promise<void> {
		this.integrationTestTmpFilesPath = this.config.getRandTmpSubDirectoryPath();

		return await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
		}, async (progress, token) => {

			// Сбрасываем статус правил в исходный
			// TODO: Добавить поддержку других типов
			const totalChildItems = this.getChildrenRecursively(this.parentItem, token);
			const rules = totalChildItems.filter(i => (i instanceof RuleBaseItem)).map<RuleBaseItem>(r => r as RuleBaseItem);
			if(rules.length === 0) {
				DialogHelper.showInfo(`В директории ${this.parentItem.getName()} не найдено контента для проверки`);
				return;
			}

			const testRunner = await this.buildAllArtifacts(rules,
				{
					progress: progress,
					cancellationToken: token
				}
			);

			for(const rule of rules) {
				// Игнорируем все, кроме правил корреляции, обогащения и нормализации
				if(!(rule instanceof Correlation) && !(rule instanceof Enrichment) && !(rule instanceof Normalization)) {
					continue;
				}

				if(rule instanceof Correlation) {
					await this.testCorrelation(
						rule,
						testRunner,
						{
							progress: progress,
							cancellationToken: token
						}
					);
				}

				if(rule instanceof Enrichment) {
					await this.testEnrichment(
						rule,
						testRunner,
						{
							progress: progress,
							cancellationToken: token
						}
					);
				}

				if(rule instanceof Normalization) {
					await this.testNormalization(
						rule,
						{
							progress: progress,
							cancellationToken: token
						}
					);
				}

				await ContentTreeProvider.refresh(rule);
			}

			DialogHelper.showInfo(`Проверка директории ${this.parentItem.getName()} завершена`);
		});
	}

	private async buildAllArtifacts(
		rules: RuleBaseItem[],
		options: {progress: any, cancellationToken: vscode.CancellationToken}
	) : Promise<IntegrationTestRunner> {
		const unionOptions = new IntegrationTestRunnerOptions();
		unionOptions.tmpFilesPath = this.integrationTestTmpFilesPath;
		unionOptions.cancellationToken = options.cancellationToken;

		// Собираем обобщенные настройки для компиляции графа корреляции.
		let correlationBuildingConfigured = false;
		let enrichmentBuildingConfigured = false;
		for(const rule of rules) {
			if(options.cancellationToken.isCancellationRequested) {
				throw new OperationCanceledException(this.config.getMessage("OperationWasAbortedByUser"));
			}

			if(rule instanceof Correlation) {
				options.progress.report({ message: `Получение зависимостей правила ${rule.getName()} для корректной сборки графа корреляций`});
				const ritd = new RunIntegrationTestDialog(this.config, {cancellationToken: options.cancellationToken});
				const ruleRunOptions = await ritd.getIntegrationTestRunOptionsForSingleRule(rule);
				unionOptions.union(ruleRunOptions);

				correlationBuildingConfigured = true;
			}

			if(rule instanceof Enrichment && !enrichmentBuildingConfigured) {
				const ruleRunOptions = await this.enrichmentBuildingConfigurationForAllEnrichment(rule);
				unionOptions.union(ruleRunOptions);

				enrichmentBuildingConfigured = true;
			}
		}

		const outputParser = new SiemJOutputParser();
		const testRunner = new IntegrationTestRunner(this.config, outputParser);

		if(correlationBuildingConfigured || enrichmentBuildingConfigured) {
			options.progress.report({ message: `Сборка артефактов для всех правил`});
			await testRunner.compileArtifacts(unionOptions);
		}
		
		// TODO: проверить результаты сборки артефактов
		return testRunner;
	}

	private async enrichmentBuildingConfigurationForAllEnrichment(rule: Enrichment): Promise<IntegrationTestRunnerOptions> {
		const testRunnerOptions = new IntegrationTestRunnerOptions();
		const result = await this.askTheUser();

		testRunnerOptions.currPackagePath = rule.getPackagePath(this.config);
		
		switch(result) {
			case this.CURRENT_PACKAGE: {
				testRunnerOptions.correlationCompilation = CompilationType.CurrentPackage;
				break;
			}

			case this.ALL_PACKAGES: {
				testRunnerOptions.correlationCompilation = CompilationType.AllPackages;
				break;
			}
			
			case this.DONT_COMPILE_CORRELATIONS: {
				testRunnerOptions.correlationCompilation = CompilationType.DontCompile;
				break;
			}
		}

		return testRunnerOptions;
	}

	private async askTheUser(): Promise<string> {
		const result = await DialogHelper.showInfo(
			"Правила обогащения из выбранной директории могут обрабатывать как нормализованные события, так и корреляционные. Какие корреляции необходимо компилировать для корректного тестирования?",
			this.CURRENT_PACKAGE,
			this.ALL_PACKAGES,
			this.DONT_COMPILE_CORRELATIONS);

		if(!result) {
			throw new OperationCanceledException(this.config.getMessage("OperationWasAbortedByUser"));
		}

		return result;
	}

	private async testNormalization(
		rule: RuleBaseItem,
		options: {progress: any, cancellationToken: vscode.CancellationToken}
	) {
		options.progress.report({ message: `Проверка тестов нормализации ${rule.getName()}`});

		if(options.cancellationToken.isCancellationRequested) {
			throw new OperationCanceledException(this.config.getMessage("OperationWasAbortedByUser"));
		}

		const tests = rule.getUnitTests();

		// Сбрасываем результаты предыдущих тестов.
		tests.forEach(t => t.setStatus(TestStatus.Unknown));
		const testHandler = async (unitTest : BaseUnitTest) => {
			const rule = unitTest.getRule();
			const testRunner = rule.getUnitTestRunner();
			return testRunner.run(unitTest);
		};

		// Запускаем все тесты
		for (let test of tests) {
			try {
				test = await testHandler(test);
			}
			catch(error) {
				test.setStatus(TestStatus.Failed);
				Log.error(error);
			} 
		}

		// Проверяем результаты тестов и меняем статус в UI.
		if(tests.every(t => t.getStatus() === TestStatus.Success)) {
			const message = "Тесты прошли проверку";
			Log.debug(message);
			rule.setStatus(ContentItemStatus.Verified, message);
		} else {
			const message = "Тесты не прошли проверку";
			Log.debug(message);
			rule.setStatus(ContentItemStatus.Unverified, message);		
		}
	}

	private async testCorrelation(
		rule: RuleBaseItem,
		runner: IntegrationTestRunner,
		options: {progress: any, cancellationToken: vscode.CancellationToken}
	) {
		options.progress.report({ message: `Проверка интеграционных тестов правила корреляции ${rule.getName()}`});
		if(options.cancellationToken.isCancellationRequested) {
			throw new OperationCanceledException(this.config.getMessage("OperationWasAbortedByUser"));
		}

		const siemjResult = await runner.run(rule);
		if (!siemjResult.testsStatus) {
			rule.setStatus(ContentItemStatus.Unverified, "Интеграционные тесты не прошли проверку");
		} else {
			rule.setStatus(ContentItemStatus.Verified, "Интеграционные тесты прошли проверку");
		}

		// TODO: временно отключены тесты локализаций, так как siemkb_tests.exe падает со следующей ошибкой:
		// TEST_RULES :: log4cplus:ERROR Unable to open file: C:\Users\user\AppData\Local\Temp\eXtraction and Processing\tmp\5239e794-c14a-7526-113c-52479c1694d6\AdAstra_TraceMode_File_Suspect_Operation_Inst_Fldr\2024-04-18_19-06-45_unknown_sdk_227gsqqu\AdAstra_TraceMode_File_Suspect_Operation_Inst_Fldr\tests\raw_events_4_norm_enr.log
		// TEST_RULES :: Error: SDK: Cannot open fpta db C:\Users\user\AppData\Local\Temp\eXtraction and Processing\tmp\5239e794-c14a-7526-113c-52479c1694d6\AdAstra_TraceMode_File_Suspect_Operation_Inst_Fldr\2024-04-18_19-06-45_unknown_sdk_227gsqqu\AdAstra_TraceMode_File_Suspect_Operation_Inst_Fldr\tests\raw_events_4_fpta.db : it's not exists
		// const testTmpDirectory = path.join(this.options.tmpFilesPath, rule.getName());

		// options.progress.report({ message: `Проверка локализации правила ${rule.getName()}`});
		// const ruleTmpFilesRuleName = path.join(this.integrationTestTmpFilesPath, rule.getName());
		// if(!fs.existsSync(ruleTmpFilesRuleName)) {
		// 	throw new XpException("Не найдены результаты выполнения интеграционных тестов");
		// }

		// const siemjManager = new SiemjManager(this.config, options.cancellationToken);
		// const locExamples = await siemjManager.buildLocalizationExamples(rule, ruleTmpFilesRuleName);

		// if (locExamples.length === 0) {
		// 	rule.setStatus(ContentItemStatus.Unverified, "Локализации не были получены");
		// 	return;
		// }

		// const verifiedLocalization = locExamples.some(le => TestHelper.isDefaultLocalization(le.ruText));
		// if(verifiedLocalization) {
		// 	rule.setStatus(
		// 		ContentItemStatus.Unverified,
		// 		"Локализация не прошла проверку, обнаружен пример локализации по умолчанию"
		// 	);
		// } else {
		// 	rule.setStatus(
		// 		ContentItemStatus.Verified,
		// 		"Интеграционные тесты и локализации прошли проверку"
		// 	);
		// }

		// rule.setLocalizationExamples(locExamples);
	}

	private async testEnrichment(
		rule: RuleBaseItem,
		runner: IntegrationTestRunner,
		options: {progress: any, cancellationToken: vscode.CancellationToken}
	) {
		options.progress.report({ message: `Проверка интеграционных тестов правила обогащения ${rule.getName()}`});

		if(options.cancellationToken.isCancellationRequested) {

			throw new OperationCanceledException(this.config.getMessage("OperationWasAbortedByUser"));
		}

		const siemjResult = await runner.run(rule);
		
		if (!siemjResult.testsStatus) {
			rule.setStatus(ContentItemStatus.Unverified, "Интеграционные тесты не прошли проверку");
		} else {
			rule.setStatus(ContentItemStatus.Verified, "Интеграционные тесты прошли проверку");
		}
	}

	private getChildrenRecursively(parentItem: ContentTreeBaseItem, cancellationToken: vscode.CancellationToken): ContentTreeBaseItem[] {
		if(cancellationToken.isCancellationRequested) {
			throw new OperationCanceledException(this.config.getMessage("OperationWasAbortedByUser"));
		}

		const items = parentItem.getChildren();
		const totalItems: ContentTreeBaseItem[] = [];

		totalItems.push(...items);
		for(const item of items) {
			const childItems = this.getChildrenRecursively(item, cancellationToken);
			totalItems.push(...childItems);
		}
		return totalItems;
	}

	private async testRule(rule: RuleBaseItem, progress: any, cancellationToken: vscode.CancellationToken) {
		// В отдельную директорию положим все временные файлы, чтобы не путаться.
		if(fs.existsSync(this.integrationTestTmpFilesPath)) {
			await FileSystemHelper.deleteAllSubDirectoriesAndFiles(this.integrationTestTmpFilesPath);
		}
		
		const ruleTmpFilesRuleName = path.join(this.integrationTestTmpFilesPath, rule.getName());
		if(!fs.existsSync(ruleTmpFilesRuleName)) {
			await fs.promises.mkdir(ruleTmpFilesRuleName, {recursive: true});
		}

		// Тестирование нормализаций
		if(rule instanceof Normalization) {
			const tests = rule.getUnitTests();

			// Сбрасываем результаты предыдущих тестов.
			tests.forEach(t => t.setStatus(TestStatus.Unknown));
			const testHandler = async (unitTest : BaseUnitTest) => {
				const rule = unitTest.getRule();
				const testRunner = rule.getUnitTestRunner();
				return testRunner.run(unitTest);
			};
	
			// Запускаем все тесты
			for (let test of tests) {
				try {
					test = await testHandler(test);
				}
				catch(error) {
					test.setStatus(TestStatus.Failed);
					Log.error(error);
				} 
			}

			// Проверяем результаты тестов и меняем статус в UI.
			if(tests.every(t => t.getStatus() === TestStatus.Success)) {
				rule.setStatus(ContentItemStatus.Verified, "Тесты прошли проверку");
				return;
			}
			rule.setStatus(ContentItemStatus.Unverified, "Тесты не прошли проверку");

			ContentTreeProvider.refresh(rule);
		}

		if(rule instanceof Correlation || rule instanceof Enrichment) {
			progress.report({ message: `Получение зависимостей правила ${rule.getName()} для корректной сборки графа корреляций` });
			const ritd = new RunIntegrationTestDialog(this.config, {tmpFilesPath: ruleTmpFilesRuleName, cancellationToken: cancellationToken});
			const options = await ritd.getIntegrationTestRunOptionsForSingleRule(rule);
			options.cancellationToken = cancellationToken;
	
			progress.report({ message: `Проверка интеграционных тестов правила ${rule.getName()}`});
			const outputParser = new SiemJOutputParser();
			const testRunner = new IntegrationTestRunner(this.config, outputParser);
	
			// TODO: исключить лишнюю сборку артефактов
			const siemjResult = await testRunner.runOnce(rule, options);
	
			if (!siemjResult.testsStatus) {
				rule.setStatus(ContentItemStatus.Unverified, "Интеграционные тесты не прошли проверку");
				return;
			}

			rule.setStatus(ContentItemStatus.Verified, "Интеграционные тесты прошли проверку");
		}

		if(rule instanceof Correlation) {
			progress.report({ message: `Проверка локализаций правила ${rule.getName()}`});
			
			const siemjManager = new SiemjManager(this.config);
			const locExamples = await siemjManager.buildLocalizationExamples(rule, ruleTmpFilesRuleName);

			if (locExamples.length === 0) {
				rule.setStatus(ContentItemStatus.Unverified, "Локализации не были получены");
				return;
			}

			const verifiedLocalization = locExamples.some(le => TestHelper.isDefaultLocalization(le.ruText));
			if(verifiedLocalization) {
				rule.setStatus(ContentItemStatus.Unverified, "Локализация не прошла проверку, обнаружен пример локализации по умолчанию");
			} else {
				rule.setStatus(ContentItemStatus.Verified, "Интеграционные тесты и локализации прошли проверку");
			}

			rule.setLocalizationExamples(locExamples);
		}
	}

	private integrationTestTmpFilesPath: string

	public ALL_PACKAGES = "Все пакеты";
	public CURRENT_PACKAGE = "Текущий пакет";
	public DONT_COMPILE_CORRELATIONS = "Не компилировать";
}