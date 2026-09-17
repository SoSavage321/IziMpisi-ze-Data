/**
 * Compliance report as a PDF.
 *
 * This document may be handed to a regulator, so it states what was measured,
 * when, against which limits, and it names the limitation that the plant
 * cannot fix (TDS) rather than quietly leaving it out.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ComplianceReport } from '@shared/reports.ts';
import { downloadBlob } from './csv.ts';

const INK = '#172B3A';      /* dark slate */
const MUTED = '#7C93A6';
const NAVY = '#0B1F33';     /* table headers */
const GOOD = '#15803D';
const CRIT = '#DC2626';
const WARN = '#B45309';

export function compliancePdf(report: ComplianceReport, opts: { timezone: string; generatedBy: string }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 44;
  let y = 54;

  const text = (s: string, size: number, colour = INK, style: 'normal' | 'bold' = 'normal', x = M) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(colour);
    doc.text(s, x, y);
  };

  // ------------------------------------------------------------- header ---
  text('WATERGUARD', 9, MUTED, 'bold');
  y += 22;
  text('Discharge compliance report', 20, INK, 'bold');
  y += 20;
  text(`${report.site} — ${report.device}`, 11, MUTED);
  y += 15;
  text(
    `Period ${fmtDate(report.from)} to ${fmtDate(report.to)} · generated ${fmtDateTime(report.generated_at)} (${opts.timezone})`,
    9, MUTED,
  );
  y += 13;
  text(`Prepared by ${opts.generatedBy}`, 9, MUTED);
  y += 22;

  doc.setDrawColor('#DBE7EE');
  doc.line(M, y, W - M, y);
  y += 26;

  // ------------------------------------------------- compliance statement ---
  const compliant = report.compliance.compliant;
  doc.setFillColor(compliant ? '#ECFDF3' : '#FEF2F2');
  doc.setDrawColor(compliant ? GOOD : CRIT);
  const stmtLines = doc.splitTextToSize(report.compliance.statement, W - 2 * M - 24);
  const boxH = 30 + stmtLines.length * 13;
  doc.roundedRect(M, y - 16, W - 2 * M, boxH, 4, 4, 'FD');
  text(compliant ? 'COMPLIANT' : 'EXCEPTIONS FOUND', 9, compliant ? GOOD : CRIT, 'bold', M + 12);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(INK);
  doc.text(stmtLines, M + 12, y);
  y += stmtLines.length * 13 + 26;

  // ----------------------------------------------------------- volumes ---
  const v = report.volumes;
  const estimated = v.measured ? '' : ' (estimated — no flow meter fitted)';
  autoTable(doc, {
    startY: y,
    head: [['Volumes' + estimated, 'Litres']],
    body: [
      ['Discharged to river after passing the test', fmt(v.direct_to_river_l)],
      ['Treated then released to river', fmt(v.treated_released_l)],
      ['Total reaching the river', fmt(v.total_to_river_l)],
      ['Failed the test and kept out of the river', fmt(v.blocked_l)],
      ['Still held in the chamber', fmt(v.held_l)],
    ],
    theme: 'grid',
    headStyles: { fillColor: NAVY, fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: INK },
    margin: { left: M, right: M },
  });
  y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;

  // ----------------------------------------------------------- quality ---
  const q = report.quality;
  autoTable(doc, {
    startY: y,
    head: [['Quality of water discharged to the river', 'Min', 'Average', 'Max', 'n']],
    body: [
      ['pH of batches released through V1', s(q.ph.min), s(q.ph.avg), s(q.ph.max), String(q.ph.n)],
      ['TDS of batches released through V1 (mg/L)', s(q.tds.min), s(q.tds.avg), s(q.tds.max), String(q.tds.n)],
      ['pH of treated releases through V3', s(q.treated_release_ph.min), s(q.treated_release_ph.avg), s(q.treated_release_ph.max), String(q.treated_release_ph.n)],
      ['TDS of treated releases through V3 (mg/L)', s(q.treated_release_tds.min), s(q.treated_release_tds.avg), s(q.treated_release_tds.max), String(q.treated_release_tds.n)],
    ],
    theme: 'grid',
    headStyles: { fillColor: NAVY, fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: INK },
    margin: { left: M, right: M },
  });
  y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;

  // -------------------------------------------------------- batches caught ---
  autoTable(doc, {
    startY: y,
    head: [['Testing performance', 'Count']],
    body: [
      ['Batches tested in the period', String(report.batches_tested)],
      ['Batches that failed and were kept out of the river', String(report.batches_failed_caught)],
      ['Treatment cycles released', String(report.treated_releases)],
    ],
    theme: 'grid',
    headStyles: { fillColor: NAVY, fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: INK },
    margin: { left: M, right: M },
  });
  y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;

  // ---------------------------------------------------------- exceptions ---
  if (report.compliance.exceptions.length) {
    autoTable(doc, {
      startY: y,
      head: [['Exception — batch', 'Reason']],
      body: report.compliance.exceptions.map((e) => [String(e.batch_no), e.reason]),
      theme: 'grid',
      headStyles: { fillColor: CRIT, fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: INK },
      margin: { left: M, right: M },
    });
    y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
  }

  if (report.compliance.tds_exceedances.length) {
    autoTable(doc, {
      startY: y,
      head: [['Treated release above the TDS limit — cycle', 'TDS at release (mg/L)']],
      body: report.compliance.tds_exceedances.map((e) => [String(e.cycle_no), String(e.end_tds)]),
      theme: 'grid',
      headStyles: { fillColor: WARN, fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: INK },
      margin: { left: M, right: M },
      didDrawPage: () => undefined,
    });
    y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text(
      doc.splitTextToSize(
        'The treatment tank corrects pH only. It does not remove dissolved salts, so a neutralised batch can still leave above the TDS limit. This is a known limitation of the current plant and is disclosed rather than omitted.',
        W - 2 * M,
      ),
      M, y + 8,
    );
    y += 34;
  }

  // ------------------------------------------------------------ incidents ---
  const inc = report.incidents;
  autoTable(doc, {
    startY: y,
    head: [['Alarms and incidents', 'Value']],
    body: [
      ['Total alarms raised', String(inc.total)],
      ['Critical', String(inc.critical)],
      ['Warning', String(inc.warning)],
      ['Left unacknowledged', String(inc.unacknowledged)],
      ['Escalated to site administrators', String(inc.escalated)],
      ['Median time to acknowledge (minutes)', inc.median_ack_minutes === null ? 'n/a' : String(inc.median_ack_minutes)],
    ],
    theme: 'grid',
    headStyles: { fillColor: NAVY, fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: INK },
    margin: { left: M, right: M },
  });
  y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;

  if (report.alarms.length) {
    autoTable(doc, {
      startY: y,
      head: [['Raised', 'Severity', 'Alarm', 'How it was handled']],
      body: report.alarms.slice(0, 40).map((a) => [
        fmtDateTime(a.raised_at),
        a.severity,
        a.message,
        a.acknowledged_at ? `Acknowledged ${fmtDateTime(a.acknowledged_at)}${a.ack_note ? `: ${a.ack_note}` : ''}` : 'Not acknowledged',
      ]),
      theme: 'striped',
      headStyles: { fillColor: NAVY, fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: INK },
      columnStyles: { 2: { cellWidth: 150 }, 3: { cellWidth: 150 } },
      margin: { left: M, right: M },
    });
    y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
  }

  // -------------------------------------------------------- config changes ---
  autoTable(doc, {
    startY: y,
    head: [['Discharge limits changed in this period', 'When', 'By', 'Reason']],
    body: report.config_changes.length
      ? report.config_changes.map((c) => [
          `v${c.version}: pH ${c.ph_min}–${c.ph_max}, TDS ≤ ${c.tds_max}`,
          fmtDateTime(c.created_at),
          c.changed_by ?? '—',
          c.reason ?? '—',
        ])
      : [['No changes to the discharge limits in this period', '', '', '']],
    theme: 'grid',
    headStyles: { fillColor: NAVY, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: INK },
    margin: { left: M, right: M },
  });
  y = (doc as never as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;

  // ---------------------------------------------------------- calibration ---
  autoTable(doc, {
    startY: y,
    head: [['Probe calibration', 'Last done', 'Next due', 'Status']],
    body: report.calibration.map((c) => [
      c.component,
      c.last_done_at ? fmtDate(c.last_done_at) : 'never',
      c.next_due_at ? fmtDate(c.next_due_at) : '—',
      c.overdue ? 'OVERDUE' : 'in date',
    ]),
    theme: 'grid',
    headStyles: { fillColor: NAVY, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: INK },
    margin: { left: M, right: M },
  });

  // ------------------------------------------------------------- footer ---
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(MUTED);
    doc.text(
      'Generated by WaterGuard from the controller’s own batch records. Figures are traceable to the batch register.',
      M, doc.internal.pageSize.getHeight() - 24,
    );
    doc.text(`${p} / ${pages}`, W - M, doc.internal.pageSize.getHeight() - 24, { align: 'right' });
  }

  downloadBlob(
    `waterguard-compliance-${report.device.replace(/\s+/g, '-')}-${report.from.slice(0, 10)}.pdf`,
    doc.output('blob'),
  );
}

const fmt = (n: number) => n.toLocaleString('en-ZA');
const s = (v: number | null) => (v === null ? '—' : String(v));
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
