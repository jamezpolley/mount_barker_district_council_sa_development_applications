// Parses the development application at the South Australian Mount Barker District Council web
// site and places them in a database.
//
// In each VSCode session: to automatically compile this TypeScript script into JavaScript whenever
// the TypeScript is changed and saved, press Ctrl+Shift+B and select "tsc:watch - tsconfig.json".
// This starts a task that watches for changes to the TypeScript script.
//
// Michael Bone
// 8th August 2018

"use strict";

import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.mountbarker.sa.gov.au/developmentregister";
const DevelopmentApplicationsYearUrl = "https://www.mountbarker.sa.gov.au/build/plan-and-develop/development-register?f.Meeting+date%7Cd=d%3D{0}+%3A%3A+{0}&num_ranks=50&fmo=true&collection=mount-barker-council-minutes-and-agenda"
const CommentUrl = "mailto:council@mountbarker.sa.gov.au";

declare const global: any;
declare const process: any;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.all("PRAGMA table_info('data')", (error, rows) => {
                if (rows.some(row => row.name === "on_notice_from"))
                    database.run("drop table [data]");  // ensure that the on_notice_from (and on_notice_to) columns are removed
                database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
                resolve(database);
            });
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or replace into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                console.log(`    Saved: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// An element (consisting of text and a bounding rectangle) in a PDF document.

interface Element {
    text: string,
    x: number,
    y: number,
    width: number,
    height: number
}

// The direction to search for an adjacent element.

enum Direction {
    Right,
    Down
}

// Calculates the square of the Euclidean distance between two elements in the specified direction.

function calculateDistance(element1: Element, element2: Element, direction: Direction) {
    if (direction === Direction.Right) {
        let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
        let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
        if (point2.x < point1.x - element1.width / 5)  // arbitrary overlap factor of 20%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    } else if (direction === Direction.Down) {
        let point1 = { x: element1.x + element1.width / 2, y: element1.y + element1.height };
        let point2 = { x: Math.min(element2.x + element1.width / 2, element2.x + element2.width), y: element2.y };
        if (point2.y < point1.y - element1.height / 2)  // arbitrary overlap factor of 50%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    }
    return Number.MAX_VALUE;
}

// Determines whether there is overlap between the two elements in the specified direction.

function isOverlap(element1: Element, element2: Element, direction: Direction) {
    if (direction === Direction.Right)
        return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
    else if (direction === Direction.Down)
        return element2.x < element1.x + element1.width && element2.x + element2.width > element1.x;
    return false;
}

// Finds the closest element either right or down from the element with the specified text.

function findClosestElement(elements: Element[], text: string, direction: Direction) {
    text = text.toLowerCase();
    let matchingElement = elements.find(element => element.text.toLowerCase().startsWith(text));
    if (matchingElement === undefined)
        return undefined;

    let closestElement: Element = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let element of elements)
        if (isOverlap(matchingElement, element, direction) && calculateDistance(matchingElement, element, direction) < calculateDistance(matchingElement, closestElement, direction))
            closestElement = element;

    return (closestElement.text === undefined) ? undefined : closestElement;
}

// Reads and parses development application details from the specified PDF.

async function parsePdf(url: string) {
    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has details of a single application (which in some cases may
    // overflow onto subsequent pages).

    const pdf = await pdfjs.getDocument({ data: buffer });

    for (let index = 0; index < pdf.numPages; index++) {
        let page = await pdf.getPage(index + 1);

        // Construct a text element for each item from the parsed PDF information.

        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
        let elements: Element[] = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: item.height };
        });

        // Find the application number, description, received date and address in the elements
        // (based on proximity to known text such as "Dev App No").

        let applicationNumberElement = findClosestElement(elements, "Dev App No", Direction.Right);
        let descriptionElement = applicationNumberElement ? findClosestElement(elements, applicationNumberElement.text, Direction.Right) : undefined;
        let receivedDateElement = findClosestElement(elements, "Application Rec'd Council", Direction.Right);
        let addressElement = findClosestElement(elements, "Property Detail", Direction.Down);

        // Ensure that the development application details are valid.

        if (applicationNumberElement === undefined ||
            applicationNumberElement.text.trim() === "" ||
            addressElement === undefined ||
            addressElement.text.trim() === "" ||
            addressElement.text.trim().toLowerCase().startsWith("property detail"))
            continue;

        let receivedDate = moment.invalid();
        if (receivedDateElement !== undefined)
            receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted

        let description = "No description provided";
        if (descriptionElement !== null && descriptionElement.text.trim() !== "")
            description = descriptionElement.text.trim();

        let developmentApplication = {
            applicationNumber: applicationNumberElement.text.trim().replace(/\s/g, ""),
            address: addressElement.text.trim(),
            description: description,
            informationUrl: url,
            commentUrl: CommentUrl,
            scrapeDate: moment().format("YYYY-MM-DD"),
            receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
        }

        developmentApplications.push(developmentApplication);
    }

    return developmentApplications;
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();    

    // Read the development applications page for another random year.

    let randomYear = getRandom(2012, moment().year()).toString();
    let randomDevelopmentApplicationsYearUrl = DevelopmentApplicationsYearUrl.replace(/\{0\}/g, encodeURIComponent(randomYear));

    console.log(`Retrieving page: ${randomDevelopmentApplicationsYearUrl}`);

    let body = await request({ url: randomDevelopmentApplicationsYearUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);

    let randomPdfUrls: string[] = [];
    for (let element of $("ul.result-listing a.result-item__link").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, randomDevelopmentApplicationsYearUrl).href
        if (pdfUrl.toLowerCase().includes("report"))
            if (!randomPdfUrls.some(url => url === pdfUrl))
                randomPdfUrls.push(pdfUrl);
    }

    // Retrieve the page that contains the links to the PDFs for this year.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    $ = cheerio.load(body);
    await sleep(2000 + getRandom(0, 5) * 1000);

    let pdfUrls: string[] = [];
    for (let element of $("div.content-container a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (pdfUrl.toLowerCase().includes("register") && !pdfUrls.some(url => url === pdfUrl))  // avoid duplicates
            pdfUrls.push(pdfUrl);
    }

    if (pdfUrls.length === 0 && randomPdfUrls.length === 0) {
        console.log("No PDF URLs were found on the pages.");
        return;
    }

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    let selectedPdfUrls: string[] = [];
    selectedPdfUrls.push(pdfUrls.shift());  // the most recent PDF
    pdfUrls = pdfUrls.concat(randomPdfUrls);
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(0, pdfUrls.length)]);

    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).

        if (global.gc)
            global.gc();

        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
