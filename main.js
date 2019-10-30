var sqlite3 = require('sqlite3').verbose()
var fs = require('fs')
var dbFile = './database.sqlite'
var dbExists = fs.existsSync(dbFile)
var beautify = require("json-beautify");
var exec = require('child_process').exec;

process.env.NTBA_FIX_319 = 1 // убирает замечание при запуске бота
const TelegramBot = require('node-telegram-bot-api');
const token = '796863974:AAEqu6W_MfgiLf7Fk3p8aLeUrmjK0f3MfD0';
const bot = new TelegramBot(token, {polling: true});

if (!dbExists)
    fs.openSync(dbFile, 'w')

var db = new sqlite3.Database(dbFile)
let sendMonospaceJson = (chatId, obj) => {
    bot.sendMessage(chatId,
        `<code>${(beautify({...obj}, null, 4, 0)).slice(0,4096)}</code>` ,
        {parse_mode : "HTML"});
}

db.run(
    `CREATE TABLE IF NOT EXISTS
    points (
        name INTEGER PRIMARY KEY AUTOINCREMENT,
        
        latitude BLOB,
        longitude BLOLB,
        radius BLOB DEFAULT 5,
        expectation TEXT,

        actual_from blob,
        actual_to blob,

        placename TEXT,
        belonged_id BLOB,
        local_order BLOB
        )`);

        
db.run(`
CREATE TABLE IF NOT EXISTS
        users(
        id TEXT,
        first_name BLOB,

        points_limit  BLOB DEFAULT 5,
        
        bio TEXT,

        chosen_radius BLOB DEFAULT 5,
        latitude BLOB,
        longitude BLOLB,
        
        last_request_time BLOB DEFAULT 1,

        experience BLOB
    )`)

db.run(`
CREATE TABLE IF NOT EXISTS
    current_act(
    action BLOB,
    next_step BLOB,
    user_id BLOB,
    arg BLOB DEFAULT NULL
    )`)

let asyncDb = (req) =>
        new Promise((res) => db.all(req, (err, rows) => res(rows)))

class Futures
{
    static async remKeyboard(user_id){
        let last = await bot.sendMessage(user_id, `Секунду`, { reply_markup:{remove_keyboard: true}})
        bot.deleteMessage(user_id, last.message_id)
    }
}

class Point
{
    static locName( lat, lon ) {
        return new Promise((res) => {
            let cmd = `curl 'https://api.opencagedata.com/geocode/v1/json?q=${lat}+${lon}&key=641c51bed8ab490184632ad8526e29ad&no_annotations=1&language=ru'`
            
            exec(cmd, function(error, stdout, stderr) {
                let parsed = JSON.parse(stdout)
                if(parsed.results)
                    res(parsed.results[0].formatted)
                else
                    res("Непонятно где")
            });
        })
    }

    static dist(lat1, lon1, lat2, lon2)
    {  // generally used geo measurement function
        console.log([lat1, lon1, lat2, lon2])

        var R = 6378.137; // Radius of earth in KM
        var dLat = lat2 * Math.PI / 180 - lat1 * Math.PI / 180;
        var dLon = lon2 * Math.PI / 180 - lon1 * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        var d = R * c;
        return d * 1000; // meters
    }

    static distance( startName, endName )
    {
        return new Promise(async (res) => {
            let startPoint = await this.load(Number(startName));
            let endPoint = await this.load(Number(endName));
             
            console.log(startPoint)
            console.log(endPoint)

            let answ = this.dist(
                startPoint.latitude, 
                startPoint.longitude, 
                endPoint.latitude, 
                endPoint.longitude
                )
            res(answ)
        })
    }

    static load(name)
    {
        return new Promise((res) => {
            db.all(`SELECT * FROM points WHERE name = ?`, name, (err, rows) => res( rows[0]))
        })
    }

    static delete(name)
    {
        db.all('DELETE FROM points WHERE name = ?', name, (err)=>console.log(err)) 
    }
}

class UserSettings
{
    static isUserExists(user_id)
    {
        let reqForUser = `SELECT * FROM users WHERE id = ?`
        return new Promise((res) => db.all(reqForUser, user_id, (err, rows) => {
            res(rows.length > 0)
        }))
    }
    
    //может ли слать заявку 
    static async isCanOffering(user_id)
    {
        let user = await this.getUser(user_id)
        return(Date.now() - user.last_request_time > 30*1000)
    }

    static updateOfferTime(user_id)
    {
        return new Promise((res) => {
            db.run(`UPDATE users SET last_request_time = ? WHERE id = ?`, Date.now(), user_id)
        })
    }
    
    static async sendOffer(targetPointName, from_id, message_id)
    {   
        if(await this.isCanOffering(from_id))
        {
            
            bot.editMessageReplyMarkup(JSON.stringify({
                inline_keyboard: [[]],
                parse_mode: 'Markdown'
                }),
                {
                    message_id: message_id,
                    chat_id: from_id,
            })

            let user = await this.getUser(from_id)
            let point = await Point.load(targetPointName)
            let targetUser = point.belonged_id
            let text = `Вам пришла заявка на встречу от <a href="tg://user?id=${user.id}">${"пользователя"}</a> для вашей точки ${point.placename}`
            bot.sendMessage(targetUser, text,  { parse_mode : "HTML" })
            bot.sendLocation(targetUser, point.latitude, point.longitude);
            bot.sendMessage(from_id, `Заявка на встречу с ссылкой на вас отправлена создателю точки`)
            await this.updateOfferTime(from_id)
        } else {
            bot.sendMessage(from_id, `Вы не можете так часто слать запросы на встречу, подождите примерно четверть минуты`)
        }
    }

    static setBio(user_id, bio)
    {
        return new Promise((res) => {
            bio = bio.slice(0, 256)
            db.run(`UPDATE users SET bio = ? WHERE id = ? `, bio, user_id, () => res())
        })
    }
    
    static setRadius(user_id, radius)
    {
        return new Promise((res) => {
            db.run(`UPDATE users SET chosen_radius = ? WHERE id = ? `, radius, user_id, () => res())
        })
    }

    static addOrUpdateUser(user_id, msgOrQuery)
    {
        return new Promise( async (res) => {
            //collection needed data
            let id = msgOrQuery.from.id
            let first_name = msgOrQuery.from.first_name
            if(await this.isUserExists(user_id))
            {
                let updateReq = `UPDATE users SET first_name = ? WHERE id = ?`
                db.run(updateReq, first_name, id, (err) => res(true))
            } else {
                let addRequest = `INSERT INTO users(id, first_name) VALUES(?, ?)`
                db.all(addRequest, id, first_name, (err) => {
                    res(true)})
            }
        })
    }

    static UpdateUser()
    {
    
    }

    static getUser(user_id)
    {
        let req = `SELECT * FROM users WHERE id = ?`
        return new Promise((res) => db.all(req, user_id, async(err, rows) => {
            if(await this.isUserExists(user_id))
                res(rows[0])
            else
                res(false)
        }))
    }
}

class PointsList
{
    static pageLength = 10

    static count()
    {

    }

    static revind = [
        {text: "⏪", callback_data: 'last left'},
        {text: "◀️", callback_data: 'left'},
        {text: "1", callback_data: 'page'},
        {text: "▶️", callback_data: 'right'},
        {text: "⏭", callback_data: 'last right'}
    ]

    static setPage = (page) => {
        let revind = this.revind.map((elm) =>
        {
            if(elm.callback_data == 'page')
                elm.text = String(page)
            else 
                elm.callback_data += " " + page
        })
        return revind
    }

    static formButtons(array, withRevind)
    {
        let formed = array.map((elm) => [{
            text:elm.placename,
            callback_data:'globalName '+elm.name
        }])


        let buttons = withRevind ? [this.revind, ...formed] : [...formed]
        console.log("formed")
        console.log(formed)

        if(formed.length < 1)
            buttons = [[{text:"Пусто", callback_data:"null"}]]

        let options = {
            reply_markup: JSON.stringify({
            inline_keyboard: buttons,
            parse_mode: 'Markdown'
            })
        }  
        return options
    }

    static all( page = 0)
    {
        return new Promise ((res) => {
            db.all(`SELECT * FROM points LIMIT ?, ?`, page*this.pageLength, this.pageLength, async (err, rows)=>{
                let options = this.formButtons(rows)
                res(options)
            })
        })
    }

    static async near(radius, center_point, page = 0)
    {
        return new Promise ((res) => {
            let lon = center_point.longitude, lat = center_point.latitude

            db.all(`SELECT COUNT(*) FROM points`, async (err, rows) => {
                let size = rows[0]['COUNT(*)'] 
                let j = 0;
                let NearPoints = []
                let stopFor = false

                let getPoint = (n) => new Promise((res)=>
                    db.get(`SELECT * FROM points LIMIT ?, 1`, n, async (err, currentPoint) => 
                        res(currentPoint)
                    ))

                for(let i = 0; i < size; i++ )
                {
                    let currentPoint = await getPoint(i)
                    if(Point.dist(lat, lon, currentPoint.latitude, currentPoint.longitude) < radius * 1000)
                    {
                        j++
                        if( j >= page * this.pageLength )
                            NearPoints.push(currentPoint)
                        
                        if( j > (page + 1) * this.pageLength + 1)
                            break
                    }
                }

                let buttons = this.formButtons(NearPoints, j > this.pageLength)
                res(buttons)
            })
        })
    }

    static myList(chat_id, page = 0)
    {
        return new Promise ((res) => {
            let request = `SELECT * FROM points WHERE belonged_id = ${chat_id} LIMIT ${this.pageLength}`
            db.all(request, async (err, rows) => {
                let options = this.formButtons(rows)
                res(options)
            })
        })
    }
}

let remKeyboard = {
    "reply_markup": {
        remove_keyboard: true
    }
}

//обработчик событий
class Handler {
    static async whatNow(msg, query)
    {
        if(msg)
            if(msg.text)
            {
                //let commands = ["Мои точки", "Список", "Кто рядом" ,"Добавить точку", "Настройки"]
                if(msg.text.match(/\/.*/))
                    return
                //if(commands)
               //     return
            }


        let msgOrQuery = msg || query
        let userID = msgOrQuery.from.id

        await UserSettings.addOrUpdateUser(userID, msgOrQuery)
        
        let actionsTable = {
            'add_point':this.addPoint,
            'nothing':this.nothing,
            'all':this.allList,
            'menu':this.menu,
            'mylist':this.myList,
            'neraby':this.nearby,
            'editUser':this.editUser
        }

        db.all(`SELECT * FROM current_act WHERE user_id = ? `, userID, async(err, rows) => {
            if(!rows[0])
                return
            let action = rows[0].action
            console.log(action)
            if(action)
                actionsTable[action](userID, msg, query)
        })
    }
    
    static nothing()
    {
        db.run(`UPDATE current_act SET action = 'nothing', next_step = 'nothing'`);
    }
    static nothingPointer = {next:"nothing", act:"nothing"}

    static previewTemplate(pointObj, userObj)
    {
        let toNormalTime = ( time ) => {
            let resTime = new Date()
            resTime.setTime(time)
            //let month = resTime.getUTCMonth()
            let day = resTime.getUTCDate()
            return day
        }

        let actual_from = toNormalTime(pointObj.actual_from)
        let actual_to = toNormalTime(pointObj.actual_to)
        
        let str = 
        `Место встречи: <pre>${pointObj.placename}</pre>\n`+
        `Актуально с ${actual_from} по ${actual_to}\n`+
        `О пользователе: ${userObj.bio || "пусто (наверное маньяк)"}\n`+
        `Ожидания от встречи: <i>${pointObj.expectation || 'еще не знаю'}</i> `
        return str
    }

    static previewMy(user_id, order)
    {
        db.all(`SELECT * FROM points WHERE belonged_id = ? and local_order = ?`, user_id, order, ( err, rows ) => {
            let thisPoint = rows[0]
            let thisUser = UserSettings.getUser(user_id);
            bot.sendMessage(user_id, this.previewTemplate(thisPoint, thisUser),{ parse_mode : "HTML" })
            bot.sendLocation(user_id, thisPoint.latitude, thisPoint.longitude)
        })
        return Handler.nothingPointer
    }
    
    //name -уникальное имя точки, user_id --куда слать точку
    static elsesPrev(name, user_id, keyboard =[[]])
    {
        db.all(`SELECT * FROM points WHERE name = ?`, name, async( err, rows ) => {
            let thisPoint = rows[0]
            let thisUser = await UserSettings.getUser(thisPoint.belonged_id);
            await bot.sendMessage(user_id, this.previewTemplate(thisPoint, thisUser),{ parse_mode : "HTML" })
            let options = {
                reply_markup: JSON.stringify({
                    inline_keyboard: keyboard,
                    parse_mode: 'Markdown'
                })
            }
            await bot.sendLocation(user_id, thisPoint.latitude, thisPoint.longitude, options)
        })
    }

    //определяет какой шаг выполнять дальше
    static stepUpdater = async(user_id, stepTable, forciblyRest) => {
        let update = await new Promise(async(res) => {
            db.get(`SELECT * FROM current_act WHERE user_id = ? `, user_id, async(err, action) => {
                console.log(action)

                if(! action)
                    await asyncDb(`INSERT INTO current_act(user_id) VALUES(${user_id})`)

                if(! action || forciblyRest)
                {
                    res(await stepTable["start"]())
                    return
                }

                let step = action.next_step
                if(! Object.keys(stepTable).find((elm) => elm == step))
                {
                    res(await stepTable["start"]())
                    return
                }

                res(await stepTable[step](action.arg))
            })
        })

        if(update.ignore)
            return
        if(update.arg)
            db.run(`UPDATE current_act SET arg = ? WHERE user_id = ?`, update.arg, user_id)
        
        db.run(`UPDATE current_act SET action = ?, next_step = ? WHERE user_id = ?`, update.act, update.next, user_id);
        return update
    }

  //  static pointsLimitPerUser = 5
    //функция процесса добавления точки
    static async addPoint(user_id, msg, query, forciblyRest)
    {
        if(!msg)
            return

        let stepTable = {
            start:start,
            init:initialization,
            branching:branching,
            expectation:expectation
        }

        let obtainOrder = () => new Promise(( res ) =>
            db.all(`SELECT max(local_order) FROM points WHERE belonged_id = ?`, user_id, (_, rows) => {
                let tempOrder = rows[0]['max(local_order)']
                if(! tempOrder)
                    tempOrder = 1
                res(tempOrder)
        }))

        //локальный индекс на последнюю точку
        let currentPointLocalOrder = await obtainOrder();
        //выполнение текущего иопределение следущего шага
        await Handler.stepUpdater(user_id, stepTable, forciblyRest)

        //предлагает начать (скинуть координаты)
        function start()
        {
            bot.sendMessage(user_id, "Отправьте точку где бы вы хотели встретится с случайным человеком")
            return {"next":"init", "act":"add_point"}
        }

        //начало 
        async function initialization() {
          //  UserSettings.
          //
            //
            if(currentPointLocalOrder >= (await UserSettings.getUser()).points_limit)
            {
                bot.sendMessage(msg.chat.id, 
                    'Вы достигли вашего лимита создания точек. \n'+
                    'Чтобы добавить новую точку удалите одну из прошлых или купите дополнительные'
                )
                return Handler.nothingPointer
            }

            let self = {"next":"init", "act":"add_point"}

            if(!msg.location)
            {
                bot.sendMessage(msg.chat.id, 'Простите, для продолжения вы должны отправить выбраную геолкацию')
                return self
            }

            let latitude = msg.location.latitude, longitude = msg.location.longitude
            let request = `INSERT INTO points(latitude, longitude, belonged_id, actual_from, actual_to, placename, local_order) VALUES(?, ?, ?, ?, ?, ?, ?)`
            let actual_from = Date.now()
            let actual_to = Date.now() + 86400 * 7 * 1000 
            let placename = await Point.locName(latitude, longitude)
            db.run(request, latitude, longitude, user_id, actual_from, actual_to, placename, currentPointLocalOrder + 1)

            bot.sendMessage(user_id,  `Точка добавлена! Теперь опишите ожидания от встречи или пропустите этот шаг, тогда в этом пункте будет указано <i>еще не знаю</i>`,
            {
                reply_markup: {
                    keyboard: [["Пропустить", "Описать"]]
                },
                parse_mode : "HTML"
            });

            return {"next":"branching", "act":"add_point"};
        }

        //либо preview
        //expect for {word:(Пропустить|Описать)}
        function branching()
        {
            let self = {"next":"branching", "act":"add_point"}
            let returning 

            if(!msg.text)
                return self

            let decision = msg.text
            let answerText  
            let remove_keyboard = true
            switch(decision)
            {
                case "Пропустить":
                    answerText = 'Готово! Ваша точка добавлена, вот как ее будут видеть другие:'
                    returning = Handler.previewMy(user_id, currentPointLocalOrder)
                    break;
                case "Описать":
                   // bot.sendMessage(msg.chat.id, 'Отправьте описание ожидания от встречи')
                    answerText = 'Отправьте описание ожидания от встречи'
                    returning = { act:"add_point", next:"expectation"}
                    break;
                default:
                   // bot.sendMessage(msg.chat.id, 'Выбран неправильный вариант')
                    answerText = 'Выбран неправильный вариант'
                    remove_keyboard = false
                    returning = self
            }
            
            bot.sendMessage(msg.chat.id, answerText, {
                "reply_markup": {
                    remove_keyboard: remove_keyboard
                    }
                });   
            bot.removeTextListener();  
            return returning
        }

        //форматирует и отправляет текст
        function expectation()
        {
            if(!msg.text)
                return Handler.nothingPointer
            let description = msg.text
            let expectationSetRequest = `UPDATE points SET expectation = ? WHERE belonged_id = ? and local_order = ?`
            db.run(expectationSetRequest, description, user_id, currentPointLocalOrder, (err, rows) => {
                bot.sendMessage(msg.chat.id, 'Ожидание успешно измененно !')
            })
            return Handler.nothingPointer
        }
    }

    static async menu(user_id, msg, query, forciblyRest)
    {

        let stepTable = {
            start:sendMenu,
            handler:choicesHandling
        }

        await Handler.stepUpdater(user_id, stepTable, forciblyRest)

        function sendMenu()
        {
            bot.sendMessage(user_id,  `Меню`,
            {
                reply_markup: {
                    keyboard: [["Мои точки", "Список", "Кто рядом"],["Добавить точку", "Настройки"]]
                },
                parse_mode : "HTML"
            });      
            return {act:"menu", next:"handler"}
        }

        async function choicesHandling()
        {
    
            let self = {act:"menu", next:"handler"}
            if(!msg)
                return self
            let options = msg.text
            let returned = self
            let ignore = {ignore:true}
            let removeKeyboard = true;

            switch (options){
                case "Мои точки":
                    Handler.myList(msg.chat.id, msg, null, true)
                    returned = ignore
                break;
                case "Список":
                    Handler.allList(msg.chat.id, msg, null, true)
                    returned = ignore
                break;
                case "Кто рядом":
                    Handler.nearby(msg.chat.id, msg, null, true)
                    returned = ignore
                break;
                case "Добавить точку":
                    Handler.addPoint(msg.chat.id, msg, null, true)
                    returned = ignore
                break;
                case "Настройки":
                    Handler.editUser(msg.chat.id, msg, null, true)
                    returned = ignore

                break;
                default: 
                await bot.sendMessage(msg.chat.id, "Неправильный вариант")
                removeKeyboard = false
            }

            if(removeKeyboard)
            {
                let lastmsg = await bot.sendMessage(msg.chat.id, "Подождите", remKeyboard)
                bot.deleteMessage(user_id, lastmsg.message_id)
            }   
            return returned
        }
    }

    static async editUser(user_id, msg, query, forciblyRest)
    {
       let stepTable = {
            start:start,
            bio:bio,
            prebio:preBio,
            preradius:preRadius,
            radius:radius,
            done:done
        }  
        
        await Handler.stepUpdater(user_id, stepTable, forciblyRest)
        async function start()
        {
            bot.sendMessage(user_id, `Изменить ваше bio ? `,{
                reply_markup:{
                    keyboard:[["Изменить", "Пропустить"]]
                }
            })
            return {next:"prebio", act:"editUser"}
        }

        async function preBio()
        {
            let self =  {next:"prebio", act:"editUser"}
            if(!msg)   
                return self
            if(!msg.text)   
                return self

            switch(msg.text)
            {
                case "Изменить":
                    bot.sendMessage(user_id, "Расскажите о себе вкартце", remKeyboard)
                    return {next:"bio", act:"editUser"}
                case "Пропустить":
                    bot.sendMessage(user_id, `Изменить ваш радиус по умолчанию ? `,{
                        reply_markup:{
                            keyboard:[["Изменить", "Пропустить"]]
                        }
                    })
                    return {next:"preradius", act:"editUser"}
                default:
                    bot.sendMessage(user_id, "Такого варианта нет")
            }

            return self
        }

        async function bio()
        {
            let self = {next:"bio", act:"editUser"}
            if(!msg)   
                return self
            if(!msg.text)   
            {
                bot.sendMessage(user_id, "Описание должно быть в текстовом формате")
                return self
            }
            let biostr = msg.text

            if(biostr.length > 256)
            {
                bot.sendMessage(user_id, "Описание не моежт быть больше 256 симовлов")
                return self
            }
            //
            UserSettings.setBio(user_id, biostr)
            bot.sendMessage(user_id, `Изменить ваш радиус по умолчанию ? `,{
                reply_markup:{
                    keyboard:[["Изменить", "Пропустить"]]
                }
            })
            return {next:"preradius", act:"editUser"}
        }
        
        async function preRadius()
        {
            let self = { next:"preradius", act:"editUser" }
            if(!msg)   
                return self
            if(!msg.text)   
                return self

            switch(msg.text)
            {
                case "Изменить":
                    bot.sendMessage(user_id, "Введите число от 1 до 500 (будет засчитаено в километрах)", remKeyboard)
                    return {next:"radius", act:"editUser"}
                case "Пропустить":
                    return done()
                default:
                    bot.sendMessage(user_id, "Такого варианта нет")
            }
            return self
        }

        async function radius()
        {
            let self = {next:"preradius", act:"editUser"}
            if(!msg)
                return self;
            if(!msg.text)
                return self;
            
            let errMsg = `Радиус должен быть положителльным числом от 1 до 500`
            let radius = msg.text
            radius = radius.match(/\d*/)[0]
            if(radius.length < 1)
            {
                bot.sendMessage(user_id, errMsg)
                return self
            }

            radius = Number(radius)
            if(radius < 1 || radius > 500)
                bot.sendMessage(user_id, errMsg)

            await UserSettings.setRadius(user_id, radius)
            return done()
        }

        async function done()
        {

            bot.sendMessage(user_id,`Готово, настройки изменены`, remKeyboard)
            return Handler.nothingPointer
        }

    }

    static editPoint()
    {

    }

    static async nearby(user_id, msg, query, forciblyRest)
    {
        let stepTable = {
            start:start,
            final:sliceNearby,
            init:getPoint,
            next:chooseNext,
            radius:settingRadius,
            handler:clicksHandlesr
        }

        await Handler.stepUpdater(user_id, stepTable, forciblyRest)
        
        async function start() {
            bot.sendMessage(user_id, `Отправьте точку около которой искать людей`)
            return {"next":"init", "act":"neraby"}
        }

        async function getPoint() {
            let self = { next:"init", act:"neraby" }
            if(!msg.location)
            {
                bot.sendMessage(user_id, 'Простите, для продолжения вы должны отправить выбраную геолкацию')
                return self
            }

            bot.sendMessage(user_id, `Хорошо теперь выберете радиус в котором искать `,{
                reply_markup:{
                    keyboard:[["По умолчанию", "Указать новый"]]
                }
            })

            let request = `UPDATE users SET longitude= ?, latitude=? WHERE id =? `
            
            return new Promise ((res) =>
                db.run(request, msg.location.longitude, msg.location.latitude, user_id, ()=>
                    res( { next:"next", act:"neraby" } )))
        }

        async function chooseNext() {
        
            let self = { next:"next", act:"neraby" }
            if(!msg)
                return self
            let option = msg.text
            if(!option)
                return self

            switch(option)
            {
                case 'По умолчанию':
                    let user = await UserSettings.getUser(user_id)
                    sliceNearby(user.chosen_radius)
                    self = { next:"handler", act:"neraby" }
                break;
                case 'Указать новый':
                    bot.sendMessage(user_id, `Введите радиус радиус (в км) `, { "reply_markup": {remove_keyboard: true }})
                    self = { next:"radius", act:"neraby" }
                break
                default:
                    bot.sendMessage(user_id, `Такого варианта нет`)
            }
            return self
        }

        async function settingRadius() {
            let self = { next:"radius", act:"neraby" }
            if(!msg)
                return self;
            if(!msg.text)
                return self;
            
            let errMsg = `Радиус должен быть положителльным числом от 1 до 500`
            let radius = msg.text
            radius = radius.match(/\d*/)[0]
            if(radius.length < 1)
            {
                bot.sendMessage(user_id, errMsg)
                return self
            }

            radius = Number(radius)
            if(radius < 1 || radius > 500)
                bot.sendMessage(user_id, errMsg)

            sliceNearby(radius)
            return { next:"handler", act:"neraby" }
        }

        async function sliceNearby(radius) {
            let user = await UserSettings.getUser(user_id)
            let buttons = await PointsList.near(radius, {latitude:user.latitude, longitude:user.longitude})
            Futures.remKeyboard(user_id)
            bot.sendMessage(user_id,`Точки в радусе ${radius} км`, buttons)
        }

        //обрабатывает нажатия типа перелистывание и тд
        async function clicksHandlesr() {
            let returning = { next:"handler", act:"neraby" }
            if(!query)
                return returning

            let words = query.data.split(' ')
            
            switch(words[0]){
                case "globalName":
                    Handler.elsesPrev(words[1], user_id, [[
                        {text:"Встретится", callback_data:"offerToMeet "+words[1]},
                    ]])
                break
                case "offerToMeet":
                    let message_id = query.message.message_id
                    UserSettings.sendOffer(words[1], user_id, message_id)
                break
            }
            return returning
        }
    }

    static async myList(user_id, msg, query, forciblyRest)
    {
        let stepTable = {
            start:sendList,
            handler:handlerQuery,
            change:change,
            remove:remove
        }

        Handler.stepUpdater(user_id, stepTable, forciblyRest)
        
        async function sendList()
        {
            let options = await PointsList.myList(user_id)
            bot.sendMessage(user_id, 'Все точки', options);
            return { act:"mylist", next:"handler" }
        }

        function handlerQuery()
        {
            let returning = { act:"mylist", next:"handler" }
            if(!query)
                return returning

            let words = query.data.split(' ')
            
            //console.log(query)
            switch(words[0]){
                case "globalName":
                    
                    Handler.elsesPrev(words[1], user_id, [[
                        {text:"Изменить", callback_data:"edit "+words[1]},
                        {text:"Удалить", callback_data:"remove "+words[1]}
                    ]])
                break;
                case "edit":
                    break;
                case "remove":

                    let options = {
                        reply_to_message_id : query.message.message_id,
                        reply_markup: {
                            keyboard: [[{text:"Удалить", callback_data:'34'}, {text:"Отмена", callback_data:"d"}]],
                        parse_mode: 'Markdown',
                    }}

                    //сохраняем name точки
                    returning = {'next':'remove', 'act':'mylist'}

                    returning = Object.assign(returning, {arg:words[1]})

                    bot.sendMessage(user_id, `Вы уверны что хотите удалить эту точку? \nВостановление невозможно.`, options)
                    break;
            }
            return returning
        }

        function change()
        {

        }

        async function remove(arg)
        {
            //тут еще нужно добавить проверку существует ли эта точка
            let returning = { act:"mylist", next:"handler" }
            if(!msg)
                return returning
            if(!msg.text)
                return returning

            returning = { act:"mylist", next:"handler" }
            let words = msg.text.split(' ')
            let remove_keyboard = true
            let answerText

            switch(words[0])
            {
                case "Удалить":
                    answerText = `Удалено`
                console.log("arg")
                console.log(arg)

                    Point.delete(arg)
                break;
                case "Отмена":
                    answerText = `Отменено`
                break; 
                default:
                    remove_keyboard = false
                    returning = {'next':'remove', 'act':'mylist'}
                    answerText = `Выбран неправильный вариант`
            }

            bot.sendMessage(user_id, answerText, {
                reply_markup:{
                    remove_keyboard:remove_keyboard
                }
            })

            return returning
        }
    }

    static async allList(user_id, msg, query, forciblyRest)
    {
        let stepTable = {
            start:sendList,
            handler:handlerQuery
        }

        await Handler.stepUpdater(user_id, stepTable, forciblyRest)

        //шлет список
        async function sendList()
        {
            let options = await PointsList.all()
            bot.sendMessage(user_id, 'Все точки', options);
            return { act:"all", next:"handler" }
        }

        //обрабатывает калбеки (на какую страницу листать и тд)
        function handlerQuery()
        {
            let self = { act:"all", next:"handler" }
            if(!query)
                return self

            let words = query.data.split(' ')
            
            switch(words[0]){
                case "globalName":
                    //шлет выбраную точку
                    Handler.elsesPrev(words[1], user_id, [[
                        {text:"Встретиться", callback_data:"offerToMeet "+words[1]},
                    ]])
                break;
                case "offerToMeet":
                    //убираем кнопку
                    let message_id =query.message.message_id
                    UserSettings.sendOffer(words[1], user_id, message_id)
                break;
                case "right":
                
                break;
                case "left":

                break;
            }
            return self
        }

        //грузит новую страницу
        function turnPage()
        {

        }
    }
}

class Statistic
{
    static update(chatid)
    {

    }

    static getStats()
    {

    }
}

bot.onText(/\/list/, async (msg) => {
   // sendMonospaceJson(msg.chat.id, await Point.list())
    PointsList.all(msg.from.id);
})

bot.onText(/\/near.*/, async (msg) => {
    PointsList.near(msg.chat.id, msg, null, true)
})

bot.onText(/\/distance.*/, async (msg) => {
    let matched = msg.text.match(/\/distance\s(\d*)\s(\d*)/) ;
    let first = matched[1]
    let end = matched[2]
    bot.sendMessage(msg.chat.id, `Растояние ${await Point.distance(first, end)} метров `)
})

bot.onText(/\/end/, (msg) => {
    bot.sendMessage(msg.chat.id, "ok", {
        "reply_markup": {
            remove_keyboard: true
            }
        });   
})

bot.on('callback_query', (query) => {
    Handler.whatNow(null, query);
    bot.answerCallbackQuery(query.id, { show_alert:false})
})

bot.onText(/\/menu/, (msg) => {
    Handler.menu(msg.chat.id, msg, null, true)
})

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
    `<strong>Это бот</strong> предназначен для поиска людей в определенной области заданной точкой и ее радиусом. `+
    `Может пригодится для путешественников, туристов или просто людей любящих случайные знакомства.\n\n`+
    
    `<strong>Пример применения</strong> : вы собираетесь в какой-то город в котором у вас нет знакомых, но город очень красивый и вам бы очень хотелось с кем-то прогулятбься в нем. `+
    `Вы выбираете функцию <i>рядом</i>, шлете координаты города и находите людей оттуда, желающих познакомиться с случайным человеком.\n\n `+
    
    `Конечно вы можете воспользоваться встроенной в телеграмм функцией чатов по геолокаций, однако нет никаких гарантий что люди оттуда желают знакомств с незнакомцами ирл.`+
    ` Да и в чат можно попасть только физически находясь на тех координатах\n\n`+
    
    `Введите /menu чтобы начать использование`
    , {parse_mode:"HTML"})
})

bot.onText(/\/add/, (msg) => {
    Handler.addPoint(msg.chat.id, msg, null, true)
})

bot.onText(/\/near/, (msg) => {
    Handler.nearby(msg.chat.id, msg, null, true)
})

bot.onText(/\/list/, (msg) => {
    Handler.allList(msg.chat.id, msg, null, true)
})

bot.onText(/\/mylist/, async (msg) => {
    Handler.myList(msg.chat.id, msg, null, true)
})

bot.on('message', async (msg) => {
    Handler.whatNow(msg, null);
    Statistic.update(msg.from.id)
})
