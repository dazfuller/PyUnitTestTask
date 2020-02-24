import tl = require('vsts-task-lib/task')
import tr = require('vsts-task-lib/toolrunner')
import path = require('path')
import fs = require('fs')
import xml2js = require('xml2js')
import * as rg from './reportgen'

let agentBuildDir = tl.getVariable('Agent.BuildDirectory');
let rootDir = tl.getPathInput('pythonroot', false, true);
let requirementFile = tl.getPathInput('reqfile', false, true);
let coverageOutput = tl.getPathInput('coveragedir', false, false);
let testFilePattern = tl.getInput("testfilepattern", true);

let testFileMask = 'TEST-*.xml';

export interface PythonError {
    message: string;
    type: string;
}
export interface PythonErrorMain {
    $: PythonError;
}
export interface TestObject {
    classname: string;
    file: string;
    line: string;
    name: string;
    time: string;
    timestamp: string;
}
export interface TestCase {
    $: TestObject;
    failure: Array<PythonErrorMain>;
    error: Array<PythonErrorMain>;
    'system-err': Array<string>;
    'system-out': Array<string>;
}
export interface TestSuitObject {
    errors: string;
    failures: string;
    file: string;
    name: string;
    skipped: string;
    tests: string;
    time: string;
    timestamp: string;
}
export interface TestSuite {
    $: TestSuitObject;
    testcase: Array<TestCase>;
}

export interface UnitTestXMLObject {
    testsuite: TestSuite;
}

/**
 * Activates the virtual environment created at the provided location
 * @param venvPath The path to the virtual environment
 */
function activateVenv(venvPath: string) {
    tl.debug('Activating virtual environment')

    let venvToolsPath = isWindows() ? 'Scripts' : 'bin';

    process.env['VIRTUAL_ENV'] = venvPath;
    process.env['PATH'] = path.join(venvPath, venvToolsPath) + path.delimiter + process.env['PATH'];
}

/**
 * Determines if the current operating system is Windows based
 */
function isWindows() {
    return tl.osType().match(/^Win/) !== null;
}

/**
 * Gets a ToolRunner for the Pip tool using the provided arguments
 * @param args A collection of arguments to provide to the tool
 */
function getPipTool(args: string[]): tr.ToolRunner {
    return tl.tool(tl.which('pip')).arg(args);
}

/**
 * Configures the environment for use
 */
async function configureEnvironment() {
     if (process.env['VIRTUAL_ENV'] === undefined) {
        tl.debug('Not currently in a virtual environment');

        // Define the location of the virtual environment
        let venv = path.join(agentBuildDir, 'venv', 'build');
        tl.debug('Virtual environment path set to: ' + venv);

        // Create the virtual environment
        tl.debug('Creating virtual environment');
        let pythonPath = isWindows() ? tl.which('python') : tl.which('python3');
        let venvTool = tl.tool(pythonPath).arg(['-m', 'venv', venv]);
        await venvTool.exec();

        // Activate the virtual environment
        activateVenv(venv);
    } else {
        tl.debug('Already in a virtual environment');
    }

    // Get the optional requirements file and restore if available
    if (fs.lstatSync(requirementFile).isFile()) {
        var pipTool = getPipTool(['install', '-r', requirementFile]);
        await pipTool.exec();
    }
}

/**
 * Sets the environment up to ensure that the unittest tools are installed and available
 */
async function setupUnittestTools() {
    var pipTool: tr.ToolRunner;

    pipTool = getPipTool(['install', 'coverage']);
    await pipTool.exec();

    pipTool = getPipTool(['install', 'unittest-xml-reporting']);
    await pipTool.exec();
}

async function run() {
    tl.cd(rootDir);
    await configureEnvironment();
    await setupUnittestTools();

    let toolRunOptions: tr.IExecSyncOptions = <any> {
        silent: true
    };

    let coverageToolPath = tl.which('coverage');

    // Execute the unit tests
    let unittestTool = tl.tool(coverageToolPath).arg(['run', '-m', 'xmlrunner', 'discover', '-s', '.', '-p', testFilePattern]);
    let unitTestToolResult = unittestTool.execSync(toolRunOptions);
    let isFailure = unitTestToolResult.stderr.match(/.*FAILED\s\((failures|errors)+\=\d[^0]+\){0,1}/gi);

    // Remove the output path if it already exists to ensure that old artefacts are not persisted
    if (tl.exist(coverageOutput)) {
        tl.rmRF(coverageOutput);
    }

    // Generate the coverage output files
    let coverageOutputPath = path.join(coverageOutput, 'coverage.xml');
    var coverageTool = tl.tool(coverageToolPath).arg(['xml', '-o', coverageOutputPath]);
    coverageTool.execSync();

    // Parse the coverage output file
    // TODO: This can be removed once VSTS tasks issue 3027 has been resolved
    // https://github.com/Microsoft/vsts-tasks/issues/3027
    let coveredClasses = rg.parseCoverageFile(coverageOutputPath);
    let coverageReport = rg.generateCoverageReport(coveredClasses);

    // Generate the coverage reports
    let coverageHtmlPath = path.join(coverageOutput, 'htmlcov');
    coverageTool = tl.tool(coverageToolPath).arg(['html', '-d', coverageHtmlPath]);
    coverageTool.execSync();

    // Rename the generated index to index_full and create a new summarised
    // index file
    // TODO: this can be removed once VSTS tasks issue 3027 has been resolved
    // https://github.com/Microsoft/vsts-tasks/issues/3027
    let indexFilePath = path.resolve(coverageHtmlPath, 'index.html');
    let indexFullFilePath = path.resolve(coverageHtmlPath, 'index_full.html');
    tl.mv(indexFilePath, indexFullFilePath);

    fs.writeFile(indexFilePath, coverageReport, { flag: 'w' }, function(err) {
        if (err) {
            return tl.setResult(tl.TaskResult.Failed, err.message);
        }
        tl.debug('Generated report file');
    });

    let failureCount = 0;
    let failedInfo: Array<string> = [];

    let parser = new xml2js.Parser();
    let allFiles = tl.find('.');
    let coverageFiles = tl.match(allFiles, testFileMask).sort()
    await Promise.all(coverageFiles.map(async element => {
        const data = await new Promise<Buffer>((resolve, reject) => fs.readFile(element, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        }));
    
        const presult = await new Promise<UnitTestXMLObject>((presolve, preject) => parser.parseString(data, (err: string, result: UnitTestXMLObject) => {
            if (err) preject(err);
            else presolve(result);
        }));

        let hasFailures = parseInt(presult.testsuite.$.failures);
        let hasErrors =  parseInt(presult.testsuite.$.errors);
        if (hasFailures) {
            presult.testsuite.testcase.forEach(v => {
                failedInfo.push(v.$.file + ' => ' + v.$.classname + '.' + v.$.name);
                failedInfo.push(v.failure[0].$.type + ': ' + v.failure[0].$.message);
            });
            failureCount += hasFailures;
        }
        if (hasErrors) {
            presult.testsuite.testcase.forEach(v => {
                failedInfo.push(v.$.file + ' => ' + v.$.classname + '.' + v.$.name);
                failedInfo.push(v.error[0].$.type + ': ' + v.error[0].$.message);
            });
            failureCount += hasErrors;
        }
    }));

    if (failureCount > 0) {
        let s = `${failureCount} failed test(s)`;
        failedInfo.forEach(f => {
            s = s + '\r\n' + f;
        });
        tl.setResult(tl.TaskResult.Failed, s);
    } else {
        tl.setResult(tl.TaskResult.Succeeded, 'Executed tests and produced coverage information');
    }
}

run();
