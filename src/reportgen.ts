import fs = require('fs')
import path = require('path')
import xml2js = require('xml2js')

export class CoveredClass {
    readonly packageName: string;
    readonly name: string;
    readonly fileName: string;
    lineCoverage: number;
    branchCoverage?: number;

    constructor(packageName: string, name: string, fileName: string) {
        this.packageName = packageName;
        this.name = name;
        this.fileName = fileName;
        this.lineCoverage = 0;
        this.branchCoverage = undefined;
    }
}

export function parseCoverageFile(coverageFile: string): Array<CoveredClass> {
    let content = fs.readFileSync(coverageFile, 'utf-8');
    let parser = new xml2js.Parser();
    var parsedFiles: Array<CoveredClass> = [];
    parser.parseString(content, function(err: any, result: any) {
        result.coverage.packages.forEach((pkgs: any) => {
            pkgs.package.forEach((pkg: any) => {
                pkg.classes[0].class.forEach((c: any) => {
                    let cc = new CoveredClass(pkg.$.name, c.$.name, c.$.filename);
                    cc.lineCoverage = parseFloat(c.$['line-rate']) * 100
                    if (c.$['branch-rate']) {
                        cc.branchCoverage = parseFloat(c.$['branch-rate']) * 100
                    }
                    parsedFiles.push(cc);
                });
            });
        });
    });
    return parsedFiles;
}

export function generateCoverageReport(classes: Array<CoveredClass>): string {
    let htmlReport = '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Coverage report</title></head>';
    htmlReport += '<body>';

    htmlReport += '<table>';

    htmlReport += '<tr>';
    htmlReport += '<th>Name</th><th>Line coverage</th><th>Branch coverage</th>';
    htmlReport += '</tr>';

    classes.forEach(c => {
        htmlReport += '<tr>';
        htmlReport += `<td>${c.fileName}</td><td>${c.lineCoverage}%</td><td>${c.branchCoverage}%</td>`
        htmlReport += '</tr>';
    });

    htmlReport += '</table>';

    htmlReport += '</body>';
    htmlReport += '</html>';

    return htmlReport;
}