'use strict';
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
(async () => {
    const outFile = path.join(require('os').tmpdir(), 'test_qc_report2.xlsx');
    if (!fs.existsSync(outFile)) { console.log('No output file yet'); return; }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outFile);
    console.log('Sheets:', wb.worksheets.map(s => s.name));
    const ws = wb.getWorksheet('Full QC report');
    console.log('Row count', ws.rowCount, 'dimensions', ws.dimensions);
    const c3 = ws.getCell('C3');
    console.log('C3 value:', c3.value, 'font:', c3.font, 'numFmt:', c3.numFmt);
    for (let r = 8; r <= 12; r++) {
        let rowstr = 'Row ' + r + ':';
        for (let c = 1; c <= 9; c++) {
            const cell = ws.getCell(r, c);
            const val = cell.value === null ? '' : JSON.stringify(cell.value).slice(0, 25);
            const f = cell.font ? `${cell.font.name || '-'}${cell.font.bold ? 'B' : ''}${cell.font.italic ? 'I' : ''} ${JSON.stringify(cell.font.color || '')}` : 'no-font';
            rowstr += ` [${c}]${val}(${f})`;
        }
        console.log(rowstr);
    }
})();
