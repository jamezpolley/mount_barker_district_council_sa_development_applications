// Parses the development application at the South Australian Mount Barker District Council web
// site and places them in a database.
//
// Michael Bone
// 8th August 2018

"use strict";

import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as pdf2json from "pdf2json";
import * as urlparser from "url";
import * as moment from "moment";
import * as fs from "fs";

sqlite3.verbose();
request.debug = true;

const DevelopmentApplicationsUrl = "https://www.mountbarker.sa.gov.au/developmentregister";
const CommentUrl = "mailto:council@mountbarker.sa.gov.au";

declare const global: any;
declare const process: any;

// console.log(process.versions);
// console.log(process.versions.openssl);
// const tls = require("tls");
// const socket = tls.connect("www.mountbarker.sa.gov.au", { path: "/developmentregister", rejectUnauthorized: false }, () => {
//     console.log(socket.authorized);
// });
// socket.on("data", data => {
//     console.log(data);
// });
// socket.on("end", data => {
//     socket.close();
// });

// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");
// console.log("Complete.");

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.reason,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();
    
    // Retrieve the page contains the links to the PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    // secureProtocol: "TLSv1_method"
    // ciphers: "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384"
    // let body = await request({ url: DevelopmentApplicationsUrl, strictSSL: false, agentOptions: { rejectUnauthorized: false, securityOptions: "SSL_OP_NO_SSLv3" } });
    // :ECDHE-RSA-AES256-SHA:AES256-SHA:RC4-SHA:RC4:HIGH
    // let body = await request({ url: DevelopmentApplicationsUrl, strictSSL: false, rejectUnauthorized: false, agentOptions: { ciphers: "ECDHE-RSA-AES256-SHA384", secureProtocol: "TLSv1_2_method", ca: ca } });
    // let body = await request({ url: DevelopmentApplicationsUrl, agentOptions: { ca: ca } });
    // let certificate = fs.readFileSync("certificate.crt");
    // let ca = fs.readFileSync("bundle3.pem");
    // let body = await request({ url: DevelopmentApplicationsUrl, strictSSL: false, rejectUnauthorized: false, agentOptions: { ciphers: "ECDHE-RSA-AES256-SHA384", secureProtocol: "TLSv1_2_method" } });
    let body = await request({ url: DevelopmentApplicationsUrl, strictSSL: false, rejectUnauthorized: false, agentOptions: { ciphers: "RSA-AES256-SHA384" } });
    let $ = cheerio.load(body);

    let pdfUrls: string[] = [];
    for (let element of $("td.uContentListDesc a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (!pdfUrls.some(url => url === pdfUrl))
            pdfUrls.push(pdfUrl);
    }

    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    let selectedPdfUrls: string[] = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);

    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Retrieving document: ${pdfUrl}`);

        // Parse the PDF into a collection of PDF rows.  Each PDF row is simply an array of
        // strings, being the text that has been parsed from the PDF.

        let pdfParser = new pdf2json();
        let pdfPipe = request({ url: pdfUrl, encoding: null }).pipe(pdfParser);
        pdfPipe.on("pdfParser_dataError", error => {
            console.log("In pdfParser_dataError catch.");
            console.log(error);
        });
        pdfPipe.on("pdfParser_dataReady", async pdf => {
            try {
                // Convert the JSON representation of the PDF into a collection of PDF rows.

                console.log(`Parsing document: ${pdfUrl}`);
                let rows = convertPdfToText(pdf);

                let developmentApplications = [];
                let developmentApplication = null;
                let isAddress = false;

                for (let row of rows) {
                    let text = (row.length === 0) ? "" : row[0].trim().toLowerCase();

                    // The start of an application is indicated by the text "Dev App No".

                    if (text.startsWith("dev app no") && row.length >= 3) {
                        developmentApplication = {
                            applicationNumber: row[1].trim().replace(/\s/g, ""),
                            address: "",
                            reason: row[2].trim(),
                            informationUrl : pdfUrl,
                            commentUrl: CommentUrl,
                            scrapeDate : moment().format("YYYY-MM-DD"),
                            receivedDate: ""
                        }
                        developmentApplications.push(developmentApplication);
                    } else if (developmentApplication !== null) {
                        // Watch for the start of an address (based on encountering the heading
                        // "Property Detail").

                        if (!isAddress && text.startsWith("property detail")) {
                            isAddress = true;
                        } else if (isAddress && (text.trim() === "" || text.startsWith("fees"))) {
                            isAddress = false;
                            developmentApplication = null;
                        } else if (isAddress && text.startsWith("property detail") && row.length >= 2) {
                            developmentApplication.address += ((developmentApplication.address === "") ? "" : " ") + row[1].trim();
                        } else if (isAddress && row.length >= 1 && (row[0].trim().startsWith("LOT:") || row[0].trim().startsWith("ALT:") || row[0].trim().startsWith("A:") || row[0].trim().startsWith("U:") || row[0].trim().startsWith("PCE:") || row[0].trim().startsWith("SEC:"))) {
                            isAddress = false;
                            developmentApplication = null;
                        } else if (isAddress && row.length >= 1) {
                            developmentApplication.address += ((developmentApplication.address === "") ? "" : " ") + row[0].trim();
                        }

                        // Attempt to find "Application Rec'd Council" anywhere on the row.

                        if (developmentApplication !== null && developmentApplication.receivedDate === "") {
                            for (let index = 0; index < row.length; index++) {
                                if (row[index].trim().toLowerCase().startsWith("application rec'd council") && index + 1 < row.length) {
                                    let receivedDate = moment(row[index + 1].trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted
                                    if (receivedDate.isValid()) {
                                        developmentApplication.receivedDate = receivedDate.format("YYYY-MM-DD");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                for (let developmentApplication of developmentApplications)
                    await insertRow(database, developmentApplication);

                console.log(`Parsed document: ${pdfUrl}`);

                // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in
                // the current process being terminated by morph.io).

                if (global.gc)
                    global.gc();
            } catch (ex) {
                console.log("In pdfParser_dataReady catch.");
                console.log(ex);
            }
        });
    }
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Convert a parsed PDF into an array of rows.  This function is based on pdf2table by Sam Decrock.
// See https://github.com/SamDecrock/pdf2table/blob/master/lib/pdf2table.js.
//
// Copyright (c) 2015 Sam Decrock <sam.decrock@gmail.com>
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

function convertPdfToText(pdf) {
    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);

    // Find the smallest Y co-ordinate for two texts with equal X co-ordinates.

    let smallestYValueForPage = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];
        let smallestYValue = null;  // per page
        let textsWithSameXValues = {};

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];
            if (!textsWithSameXValues[text.x])
                textsWithSameXValues[text.x] = [];
            textsWithSameXValues[text.x].push(text);
        }

        // Find smallest Y distance.

        for (let x in textsWithSameXValues) {
            let texts = textsWithSameXValues[x];
            for (let i = 0; i < texts.length; i++) {
                for (let j = 0; j < texts.length; j++) {
                    if (texts[i] !== texts[j]) {
                        let distance = Math.abs(texts[j].y - texts[i].y);
                        if (smallestYValue === null || distance < smallestYValue)
                            smallestYValue = distance;
                    }
                };
            };
        }

        if (smallestYValue === null)
            smallestYValue = 0;
        smallestYValueForPage.push(smallestYValue);
    }

    // Find texts with similar Y values (in the range of Y - smallestYValue to Y + smallestYValue).

    let myPages = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];

        let rows = [];  // store texts and their X positions in rows

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];

            let foundRow = false;
            for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
                // Y value of text falls within the Y value range, add text to row.

                let maximumYdifference = smallestYValueForPage[pageIndex];
                if (rows[rowIndex].y - maximumYdifference < text.y && text.y < rows[rowIndex].y + maximumYdifference) {
                    // Only add value of T to data (which is the actual text).

                    for (let index = 0; index < text.R.length; index++)
                        rows[rowIndex].data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                    foundRow = true;
                }
            };

            // Create a new row and add the text to the row.

            if (!foundRow) {
                let row = { y: text.y, data: [] };
                for (let index = 0; index < text.R.length; index++)
                    row.data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                rows.push(row);
            }
        };

        // Sort each extracted row horizontally by X co-ordinate.

        for (let index = 0; index < rows.length; index++)
            rows[index].data.sort(xComparer);

        // Sort rows vertically by Y co-ordinate.

        rows.sort(yComparer);

        // Add rows to pages.

        myPages.push(rows);
    };

    // Flatten pages into rows.

    let rows = [];

    for (let pageIndex = 0; pageIndex < myPages.length; pageIndex++) {
        for (let rowIndex = 0; rowIndex < myPages[pageIndex].length; rowIndex++) {
            // Now that each row is made of objects extract the text property from the object.

            let rowEntries = []
            let row = myPages[pageIndex][rowIndex].data;
            for (let index = 0; index < row.length; index++)
                rowEntries.push(row[index].text);

            // Append the extracted and ordered text into the return rows.

            rows.push(rowEntries);
        };
    };

    return rows;
}

main().catch(error => console.error(error));
