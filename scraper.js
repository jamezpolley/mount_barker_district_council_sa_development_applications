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
Object.defineProperty(exports, "__esModule", { value: true });
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "https://www.mountbarker.sa.gov.au/developmentregister";
const CommentUrl = "mailto:council@mountbarker.sa.gov.au";
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
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// The direction to search for an adjacent element.
var Direction;
(function (Direction) {
    Direction[Direction["Right"] = 0] = "Right";
    Direction[Direction["Down"] = 1] = "Down";
})(Direction || (Direction = {}));
// Calculates the square of the Euclidean distance between two elements in the specified direction.
function calculateDistance(element1, element2, direction) {
    if (direction === Direction.Right) {
        let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
        let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
        if (point2.x < point1.x - element1.width / 5) // arbitrary overlap factor of 20%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    }
    else if (direction === Direction.Down) {
        let point1 = { x: element1.x + element1.width / 2, y: element1.y + element1.height };
        let point2 = { x: Math.min(element2.x + element1.width / 2, element2.x + element2.width), y: element2.y };
        if (point2.y < point1.y - element1.height / 2) // arbitrary overlap factor of 50%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    }
    return Number.MAX_VALUE;
}
// Determines whether there is overlap between the two elements in the specified direction.
function isOverlap(element1, element2, direction) {
    if (direction === Direction.Right)
        return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
    else if (direction === Direction.Down)
        return element2.x < element1.x + element1.width && element2.x + element2.width > element1.x;
    return false;
}
// Finds the closest element either right or down from the element with the specified text.
function findClosestElement(elements, text, direction) {
    text = text.toLowerCase();
    let matchingElement = elements.find(element => element.text.toLowerCase().startsWith(text));
    if (matchingElement === undefined)
        return undefined;
    let closestElement = undefined;
    for (let element of elements)
        if (closestElement === undefined || (isOverlap(matchingElement, element, direction) && calculateDistance(matchingElement, element, direction) < calculateDistance(matchingElement, closestElement, direction)))
            closestElement = element;
    return closestElement;
}
// Reads and parses development application details from the specified PDF.
async function parsePdf(url) {
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
        let elements = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: item.height };
        });
        // Find the application number, reason, received date and address in the elements (based
        // on proximity to known text such as "Dev App No").
        let applicationNumberElement = findClosestElement(elements, "Dev App No", Direction.Right);
        let reasonElement = applicationNumberElement ? findClosestElement(elements, applicationNumberElement.text, Direction.Right) : undefined;
        let receivedDateElement = findClosestElement(elements, "Application Rec'd Council", Direction.Right);
        let addressElement = findClosestElement(elements, "Property Detail", Direction.Down);
        // Ensure that the development application details are valid.
        if (applicationNumberElement !== undefined && applicationNumberElement.text.trim() !== "" && addressElement !== undefined && addressElement.text.trim() !== "") {
            let receivedDate = moment.invalid();
            if (receivedDateElement !== undefined)
                receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true); // allows the leading zero of the day to be omitted
            let reason = "No description provided";
            if (reasonElement !== null && reasonElement.text.trim() !== "")
                reason = reasonElement.text.trim();
            let developmentApplication = {
                applicationNumber: applicationNumberElement.text.trim().replace(/\s/g, ""),
                address: addressElement.text.trim(),
                reason: reason,
                informationUrl: url,
                commentUrl: CommentUrl,
                scrapeDate: moment().format("YYYY-MM-DD"),
                receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
            };
            developmentApplications.push(developmentApplication);
        }
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Retrieve the page that contains the links to the PDFs.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    let $ = cheerio.load(body);
    await sleep(2000 + getRandom(0, 5) * 1000);
    let pdfUrls = [];
    for (let element of $("td.uContentListDesc a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (!pdfUrls.some(url => url === pdfUrl)) // avoid duplicates
            pdfUrls.push(pdfUrl);
    }
    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }
    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).
    let selectedPdfUrls = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsK0ZBQStGO0FBQy9GLHNDQUFzQztBQUN0QyxFQUFFO0FBQ0YsbUdBQW1HO0FBQ25HLGtHQUFrRztBQUNsRyx3RUFBd0U7QUFDeEUsRUFBRTtBQUNGLGVBQWU7QUFDZixrQkFBa0I7QUFFbEIsWUFBWSxDQUFDOztBQUViLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQyxpQ0FBaUM7QUFDakMsb0NBQW9DO0FBRXBDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUVsQixNQUFNLDBCQUEwQixHQUFHLHVEQUF1RCxDQUFDO0FBQzNGLE1BQU0sVUFBVSxHQUFHLHNDQUFzQyxDQUFDO0FBSTFELDhCQUE4QjtBQUU5QixLQUFLLFVBQVUsa0JBQWtCO0lBQzdCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ25ELFFBQVEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFO1lBQ3BCLFFBQVEsQ0FBQyxHQUFHLENBQUMsME9BQTBPLENBQUMsQ0FBQztZQUN6UCxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdEIsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUM7QUFFRCw4REFBOEQ7QUFFOUQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxRQUFRLEVBQUUsc0JBQXNCO0lBQ3JELE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxZQUFZLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQyxpRUFBaUUsQ0FBQyxDQUFDO1FBQ3ZHLFlBQVksQ0FBQyxHQUFH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