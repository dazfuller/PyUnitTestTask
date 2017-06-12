import tl = require('vsts-task-lib/task')
import tr = require('vsts-task-lib/toolrunner')
import path = require('path')

let agentBuildDir = tl.getVariable('Agent.BuildDirectory');
let rootDir = tl.getPathInput('pythonroot', false, true);
let requirementFile = tl.getPathInput('reqfile', false, true);
let coverageOutput = tl.getPathInput('coveragedir', false, false);

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
    if (requirementFile !== null) {
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
    let unittestTool = tl.tool(coverageToolPath).arg(['run', '-m', 'xmlrunner', 'discover']);
    unittestTool.execSync(toolRunOptions);

    // Generate the coverage output files
    let coverageOutputPath = path.join(coverageOutput, 'coverage.xml');
    var coverageTool = tl.tool(coverageToolPath).arg(['xml', '-o', coverageOutputPath]);
    coverageTool.execSync();

    // Generate the coverage reports
    let coverageHtmlPath = path.join(coverageOutput, 'htmlcov');
    coverageTool = tl.tool(coverageToolPath).arg(['html', '-d', coverageHtmlPath]);
    coverageTool.execSync();
}

run();