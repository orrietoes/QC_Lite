'use strict';
const path    = require('path');
const fs      = require('fs');
const ExcelJS = require('exceljs');
const { generateExcelReport } = require('./report_export');

const tmp  = require('os').tmpdir();
const proj = path.join(tmp, 'qc_lite_test_proj2');
fs.mkdirSync(path.join(proj, 'qc'), { recursive: true });

const l2 = {
    sections: {
        'sec_001': {
            decision: 'approved', tickets: [],
            manual_tickets: [
                { ticket_id: 'a', source: 'manual', type: 'MISREAD',      severity: 'CRITICAL',    start_time: 65.5,  comment: 'Test misread', page: '42' },
                { ticket_id: 'b', source: 'manual', type: 'NOISE',        severity: 'DISTRACTING', start_time: 120.0, comment: 'Background noise', page: '43' },
            ]
        },
        'sec_002': {
            decision: 'pending', tickets: [],
            manual_tickets: [
                { ticket_id: 'c', source: 'manual', type: 'PRONUNCIATION', severity: 'DISTRACTING', start_time: 30.0, comment: 'Mispronounced', page: '101' },
            ]
        }
    }
};
fs.writeFileSync(path.join(proj, 'qc', 'l2.json'), JSON.stringify(l2, null, 2));

generateExcelReport(proj).then(async ({ buffer, ticketCount }) => {
    const out = path.join(tmp, 'test_qc_report2.xlsx');
    fs.writeFileSync(out, Buffer.from(buffer));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);

    // Check sheet count
    console.log('Sheet names:', wb.worksheets.map(s => s.name));

    const ws = wb.getWorksheet('Full QC report');
    console.log('Rows 9-11:');
    for (let r = 9; r <= 11; r++) {
        const sev  = ws.getCell(r, 9);
        const font = sev.font || {};
        console.log(`  Row ${r}: Severity="${sev.value}" strike=${!!font.strike} bold=${!!font.bold}`);
    }
    console.log('ticketCount:', ticketCount);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
